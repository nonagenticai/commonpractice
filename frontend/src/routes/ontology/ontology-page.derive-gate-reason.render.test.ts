// @vitest-environment jsdom
//
// src/routes/ontology/ontology-page.derive-gate-reason.render.test.ts — "Datablok afleiden" says
// why it is inert.
//
// ⛔ THE DEFECT. The button was
//
//     <button disabled={deriveBusy || samples.length === 0}
//             title={samples.length === 0 ? m.ontology_derive_block_no_sample() : ''}>
//
// and A DISABLED BUTTON FIRES NO POINTER EVENTS — so that `title` never surfaces a tooltip. The one
// sentence explaining the gate ("Koppel eerst primaire testdata") was translated into eight
// languages, shipped, and unreachable by every reader by every means. It existed only in the source.
//
// ⛔ `VoteButton.svelte` STATES THIS RULE FOR THIS CODEBASE, IN WRITING: "The reason lives on a
// WRAPPER, not on the button: a disabled button fires no pointer events, so a `title` on it never
// surfaces a tooltip. It is a supplement in any case — the same fact is always on screen next to
// it … because a tooltip alone is not reachable by keyboard." This site predates that note, and
// BOTH halves are asserted here: a wrapper-only fix is one a mouse user can see and nobody else can.
//
// ⚠️ THE NEARBY "Nog geen testgegevens gekoppeld." IS NOT THE SAME SENTENCE, which is why moving the
// title is not redundant with it. That line says there IS no test data; it does not say that is what
// makes Derive inert, and it sits in a different section of the panel.
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
import Page from './+page.svelte';

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** `messages/nl.json` — the sentence that could never reach a reader. */
const NO_SAMPLE_NL = 'Koppel eerst primaire testdata';

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

const matrix = (): MatrixData =>
	({
		industries: ['Insurance'],
		departments: ['Claims'],
		cells: [{ industry: 'Insurance', department: 'Claims', hasSpecialization: true }],
		canManage: true
	}) as MatrixData;

/** ⛔ `canManage: true` — the whole test-data section, Derive included, is behind it. */
const ontology = (): CompiledOntology =>
	({
		industry: 'Insurance',
		department: 'Claims',
		entities: [entity('Claim', 'Schadeclaim')],
		relations: [],
		hidden: [],
		canManage: true
	}) as CompiledOntology;

/** The variable under test: whether the selected entity has a bound sample. */
let boundSamples: unknown[] = [];

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
	boundSamples = [];
	overwriteGetLocale(() => 'nl');
	authFetch.mockImplementation(async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : String(input);
		if (url === '/api/ontology/matrix') return json(matrix());
		if (url.startsWith('/api/ontology?')) return json(ontology());
		if (url === '/api/ontology/recent-changes') return json({ items: [], unattributed: 0 });
		if (url.endsWith('/samples')) return json({ samples: boundSamples });
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
 * Mount /ontology and open the `Claim` entity's detail panel.
 *
 * ⛔ POSITIVE MARKERS, IN ORDER. This page mounts SvelteFlow and a dozen panels; without them every
 * "the reason is gone" assertion below passes for free on a page that never rendered, and the
 * `deriveButton()` lookup would fail for the wrong reason.
 */
async function openDetail(): Promise<void> {
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
}

function deriveButton(): HTMLButtonElement {
	const btn = host.querySelector('button.derive-btn') as HTMLButtonElement | null;
	expect(btn, 'the Derive control never rendered — this case tests nothing').not.toBeNull();
	return btn!;
}
const gateLine = () => host.querySelector('[data-testid="derive-gate"]');

describe('/ontology — "Datablok afleiden" with no test data bound', () => {
	it('⛔ THE DEFECT: the reason is on a WRAPPER, because the button cannot fire a tooltip', async () => {
		// REVERT THAT TURNS THIS RED: put `title=` back on the `<button>`. The string is then present
		// in the DOM and permanently unreachable — which is exactly why this asserts on the WRAPPER
		// rather than on the sentence existing somewhere.
		await openDetail();
		const btn = deriveButton();
		expect(btn.disabled, 'the control is not actually gated, so the reason is moot').toBe(true);

		const wrap = btn.closest('.gate-wrap');
		expect(wrap, 'the gated control has no wrapper to carry its reason').not.toBeNull();
		expect(wrap!.getAttribute('title')).toBe(NO_SAMPLE_NL);
		expect(
			btn.getAttribute('title'),
			'the reason went back onto the disabled button, where it can never surface'
		).toBeNull();
	});

	it('⛔ …AND IT IS ON SCREEN, because a tooltip is not reachable by keyboard', async () => {
		// The half a wrapper-only fix leaves out.
		await openDetail();
		const line = gateLine();
		expect(line, 'the reason is a tooltip and nothing else').not.toBeNull();
		expect(squash(line!.textContent)).toBe(NO_SAMPLE_NL);
	});

	it('⛔ WITH A SAMPLE BOUND THE CONTROL IS LIVE AND NOTHING IS EXPLAINED AWAY', async () => {
		// The complement. An always-disabled button, or an unconditional notice, satisfies both cases
		// above and removes the feature.
		boundSamples = [
			{ id: 's-1', datasetId: 'd-1', datasetName: 'Claims 2026', rowCount: 42, isPrimary: true }
		];
		await openDetail();

		expect(deriveButton().disabled, 'Derive stayed inert with a primary sample bound').toBe(false);
		expect(gateLine(), 'a gate that is open was still explained').toBeNull();
		expect(
			deriveButton().closest('.gate-wrap')!.getAttribute('title'),
			'an open gate still carries a reason'
		).toBeNull();
	});
});
