// @vitest-environment jsdom
//
// src/routes/ontology/ontology-page.translation-erase.render.test.ts — "Saved" over a DELETE.
//
// ⛔ THE DEFECT, AND THE BACKEND MAKES IT WORSE RATHER THAN SAFER. `openEditEntity()` swallowed a
// failed `GET …/translations` into `catch { /* keep empty */ }` and left `translations[loc] = {}`.
// `saveTranslation()` then PUT `{ label: t.label ?? '', description: t.description ?? '' }` — both
// keys always present, both empty — and reported `ontology_translation_saved`.
//
// On the receiving side `PUT /api/ontology/entities/:id/translations` is SPARSE BY KEY PRESENCE on
// purpose (backend/src/routes/ontology.ts:271-279, and its comment says so), and
// `setEntityTranslations` (backend/src/ontology/ontology-service.ts:1053-1060) routes a falsy
// TRIMMED value to `deleteTranslation`. So one blipped GET turned Save into ERASE: the author's
// existing Dutch label and description were deleted, the API answered 200, and the screen said it
// worked.
//
// ⛔ WHY DROPPING THE `?? ''` IS NOT THE FIX, and why this file asserts the WIRE. Sending nothing
// would make the same failed GET produce a save that silently does nothing — still a lie, just a
// quieter one. And `''` MUST STAY SENDABLE: an intentional clear is the documented semantic of that
// endpoint. So the fix is to know whether the GET succeeded and refuse to save when it did not, and
// the assertions below are on the REQUEST BODY (or its absence), never on a state variable.
//
// ⛔ NOTHING IN `$lib/api/ontology` IS MOCKED. Only `$lib/api/auth-fetch` is, answering real
// `Response` objects, so the failing GET travels through the client's own `unwrap` and the PUT that
// would be issued is the exact body the browser would put on the wire. See
// `src/lib/api/error-message.wire.test.ts` for why a hand-built rejection proves nothing here.
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

import * as m from '$lib/paraglide/messages';
import Page from './+page.svelte';

const ENTITY_ID = 'ent-broker-note';
const TX_URL = `/api/ontology/entities/${ENTITY_ID}/translations`;
/** What the entity really has in `nl` today — the thing an erase destroys. */
const EXISTING = { label: 'Makelaarsnotitie', description: 'Notitie van de makelaar' };

// ── the wire ────────────────────────────────────────────────────────────────────────────────────
/** Every request, as `METHOD /path`, with the parsed JSON body for writes. */
let wire: { method: string; url: string; body: unknown }[] = [];
/** What `GET …/translations` answers. Swapped per case. */
let txGet: { status: number; body: unknown } = { status: 200, body: { translations: {} } };

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function entity(): OntologyEntity {
	return {
		id: ENTITY_ID,
		key: 'industry_dept:Insurance:Claims:BrokerNote',
		name: 'BrokerNote',
		label: 'Broker note',
		synonyms: [],
		description: 'A note from the broker',
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
const buttonLabelled = (label: string) =>
	[...host.querySelectorAll<HTMLButtonElement>('button')].find(
		(b) => b.textContent?.trim() === label
	);
const txBlock = () => host.querySelector('.tx-block') as HTMLElement | null;
const txInputs = () => [...host.querySelectorAll<HTMLInputElement>('.tx-block .tx-input')];
const saveTxButton = () => {
	const b = buttonLabelled(m.ontology_save_translation());
	expect(b, 'the Save-translation button is not on screen').toBeTruthy();
	return b!;
};
/** Every PUT the page put on the wire for this entity's translations. */
const puts = () => wire.filter((c) => c.method === 'PUT' && c.url === TX_URL);

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
	wire = [];
	txGet = { status: 200, body: { translations: { nl: { ...EXISTING } } } };
	authFetch.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const url = typeof input === 'string' ? input : String(input);
		const method = (init.method ?? 'GET').toUpperCase();
		const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
		wire.push({ method, url, body });
		if (url === TX_URL && method === 'GET') return json(txGet.body, txGet.status);
		if (url === TX_URL && method === 'PUT') return json({ ok: true });
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

/** Mount /ontology, select the tenant entity in the graph, and open its editor. */
async function openEditor() {
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
	await settle();
	const node = host.querySelector('.svelte-flow__node');
	// ⛔ POSITIVE MARKERS. /ontology mounts SvelteFlow and a dozen panels; without these, "no PUT was
	// issued" passes for free on a page that never rendered.
	expect(node, 'the entity graph never rendered — nothing here is reachable').toBeTruthy();
	click(node!);
	await settle();
	const edit = buttonLabelled(m.ontology_edit());
	expect(edit, 'the entity detail panel offered no Edit — the editor is unreachable').toBeTruthy();
	click(edit!);
	await settle();
	await settle();
	expect(txBlock(), 'the translations block never rendered').toBeTruthy();
	expect(
		wire.some((c) => c.method === 'GET' && c.url === TX_URL),
		'the editor never asked for the translations'
	).toBe(true);
}

/** Type into one of the two translation fields the way an author does. */
function typeInto(idx: number, value: string) {
	const el = txInputs()[idx];
	expect(el, `translation field ${idx} is not rendered`).toBeTruthy();
	el!.value = value;
	el!.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('/ontology never turns a failed translation load into a delete', () => {
	it('⛔ THE DEFECT: a 503 on the GET, then Save, sent label:"" description:"" and said "Saved"', async () => {
		txGet = { status: 503, body: { error: 'upstream_unavailable' } };
		await openEditor();

		click(saveTxButton());
		await settle();

		// ⛔ THE WIRE IS THE ASSERTION. On the defect this is one PUT carrying two empty strings,
		// which `setEntityTranslations` resolves to two `deleteTranslation` calls.
		expect(
			puts(),
			'Save issued a write built from translations that were never loaded — ' +
				`each empty field DELETES the stored one (${JSON.stringify(puts()[0]?.body)})`
		).toHaveLength(0);
		expect(
			host.textContent,
			'the screen reported a successful save for a write it could not honestly make'
		).not.toContain(m.ontology_translation_saved());
	});

	it('⛔ …and the failure is on screen, with Save switched off rather than merely ineffective', async () => {
		txGet = { status: 503, body: { error: 'upstream_unavailable' } };
		await openEditor();

		expect(txBlock()!.textContent, 'the failed load left no trace on the panel').toContain(
			m.ontology_translations_load_failed()
		);
		expect(
			saveTxButton().disabled,
			'Save is still live over fields that hold nothing the author wrote'
		).toBe(true);
	});

	it('THE SAVE STILL WORKS: a loaded entity round-trips its edited label', async () => {
		// ⛔ THE OVER-CORRECTION GUARD. Disabling Save unconditionally passes both cases above forever.
		await openEditor();
		expect(txBlock()!.textContent).not.toContain(m.ontology_translations_load_failed());
		expect(saveTxButton().disabled, 'a healthy load left Save disabled').toBe(false);
		// The loaded values really reached the fields — otherwise the PUT below proves nothing.
		expect(txInputs()[0]?.value, 'the fetched label never reached the input').toBe(EXISTING.label);

		typeInto(0, 'Makelaarsbericht');
		click(saveTxButton());
		await settle();

		expect(puts(), 'a healthy Save issued no write').toHaveLength(1);
		expect(puts()[0]!.body).toEqual({
			locale: 'nl',
			label: 'Makelaarsbericht',
			description: EXISTING.description
		});
		expect(host.textContent).toContain(m.ontology_translation_saved());
	});

	it("AN INTENTIONAL CLEAR STILL SENDS '' — the endpoint's documented way to remove a translation",
		async () => {
			// ⛔ THE CONSTRAINT THAT RULES OUT THE CHEAP FIX. "Stop sending `?? ''`" would make an
			// author who deliberately empties the field save nothing at all, which is the same lie in a
			// quieter register. The empty string has to survive — what must not survive is an empty
			// string the author never typed.
			await openEditor();
			typeInto(0, '');
			click(saveTxButton());
			await settle();

			expect(puts(), 'an intentional clear issued no write').toHaveLength(1);
			expect(puts()[0]!.body).toEqual({
				locale: 'nl',
				label: '',
				description: EXISTING.description
			});
		});
});
