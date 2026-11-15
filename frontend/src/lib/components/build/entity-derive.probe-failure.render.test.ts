// @vitest-environment jsdom
//
// src/lib/components/build/entity-derive.probe-failure.render.test.ts — a FAILED readiness probe is
// not an absence of test data, and it must not disable the only button on the screen.
//
// ⛔ THE DEFECT. `loadEntities()` probed every entity in the cell with
//
//     entities.map(async (e) => [e.id, await ontologyApi.listSamples(e.id).catch(() => [])])
//
// and that `.catch` sat INSIDE the outer `try`. So a failing `GET /api/ontology/entities/:id/samples`
// never reached the `error` state — it silently became `samples[id] = []`. Everything downstream
// then read that empty list as a MEASUREMENT: `hasPrimary()` went false, the card claimed
// `blockedit_derive_no_sample` ("no sample bound"), the preview repeated it as
// `blockedit_derive_no_sample_help` ("go bind one on the Ontology screen"), and `canDerive` went
// false — so the primary Derive button was disabled FOREVER, with no visible reason and no retry
// path short of reloading the page. One 500 on a decorative readiness probe permanently removed the
// feature this whole component exists for, while telling the author a falsehood about their own
// data and sending them to a screen where nothing was wrong.
//
// ⛔ THE FIX IS A THIRD STATE, NOT A LOUDER SECOND ONE. has-primary / confirmed-none / UNKNOWN.
// Only the middle one may say "no sample bound". Unknown says so in its own words, keeps `canDerive`
// permissive (the backend re-checks at derive time and answers with a real refusal — a client-side
// GUESS must not out-rank a server-side FACT), and offers a re-check.
//
// ⚠️ THE LAST CASE IS THE OVER-CORRECTION GUARD. Making every entity derivable would pass every
// case above; a genuinely empty (successfully measured) sample list must still say "no sample
// bound" and must still disable Derive.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { EntitySample, OntologyEntity } from '$lib/types/ontology';

// ⚠️ THE REAL `en` CATALOG, and ONLY it. Each key resolves to its own NAME, exactly like every
// sibling render test, so an assertion can never be satisfied by a coincidence of English prose.
// ⛔ It briefly carried a hard-coded PENDING_KEYS list while the two new keys were being merged into
// `messages/*.json` in a separate step. That list is gone on purpose: left in, this test would keep
// passing on the day those keys were dropped from the catalogs, which is the one thing it is here
// to notice.
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

const { matrix, getOntology, listSamples, deriveBlock } = vi.hoisted(() => ({
	matrix: vi.fn(),
	getOntology: vi.fn(),
	listSamples: vi.fn(),
	deriveBlock: vi.fn()
}));
// ⛔ ALIAS module ids, never relative ones — a relative mock id resolves to a different module
// record than the component imports and silently does nothing.
vi.mock('$lib/api/ontology', () => ({
	ontologyApi: { matrix, get: getOntology, listSamples, deriveBlock }
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));

import * as m from '$lib/paraglide/messages';
import EntityDeriveBrowser from './EntityDeriveBrowser.svelte';

const mm = m as unknown as Record<string, () => string>;
const OK_ID = 'ent-ok';
const FAIL_ID = 'ent-probe-500';
const NONE_ID = 'ent-empty';

function entity(id: string, label: string): OntologyEntity {
	return {
		id,
		key: `industry:insurance:claims:${id}`,
		name: id,
		label,
		synonyms: [],
		description: null,
		scope: 'industry_dept',
		tenantOwned: false,
		attributes: [{ name: 'amount', type: 'number', synonyms: [], pii: false, description: null }]
	};
}

function sample(isPrimary: boolean): EntitySample {
	return {
		id: 's1',
		datasetId: 'd1',
		datasetSlug: 'claims-2026',
		datasetName: 'Claims 2026',
		rowCount: 120,
		mappingId: 'map-1',
		isPrimary
	};
}

let target: HTMLElement;
let component: Record<string, unknown> | null = null;
let derived: string[] = [];

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

const cards = () => [...target.querySelectorAll<HTMLElement>('button.ecard')];
function card(label: string): HTMLElement {
	const el = cards().find((c) => c.querySelector('.ec-name')?.textContent?.trim() === label);
	expect(el, `no entity card labelled "${label}" — this file would test nothing`).toBeTruthy();
	return el!;
}
function readiness(label: string): string {
	return card(label).querySelector('.ec-ready')?.textContent?.trim() ?? '';
}
function deriveButton(): HTMLButtonElement {
	const btn = [...target.querySelectorAll<HTMLButtonElement>('.preview button.btn-primary')][0];
	expect(btn, 'the preview never rendered its Derive button').toBeTruthy();
	return btn;
}
const previewText = () => target.querySelector('.preview')?.textContent ?? '';

/** Mount, pick the industry × department cell, and wait for the entity grid. */
async function browseCell() {
	component = mount(EntityDeriveBrowser, {
		target,
		props: { onDerived: (slug: string) => derived.push(slug) }
	}) as Record<string, unknown>;
	await settle();
	const [ind, dep] = [...target.querySelectorAll<HTMLSelectElement>('.onto-row select')];
	expect(ind && dep, 'the industry/department selectors never rendered').toBeTruthy();
	ind.value = 'insurance';
	// `bubbles: true` — Svelte 5 DELEGATES `change` to the mount root, so a non-bubbling synthetic
	// event would reach `bind:value` but never the `onchange` handler, and this would pass or fail
	// on an artifact of the harness rather than on behaviour.
	ind.dispatchEvent(new Event('change', { bubbles: true }));
	await settle();
	dep.value = 'claims';
	dep.dispatchEvent(new Event('change', { bubbles: true }));
	await settle();
	expect(cards().length, 'the entity grid never rendered — this file would test nothing').toBe(3);
}

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	derived = [];
	matrix.mockResolvedValue({
		industries: ['insurance'],
		departments: ['claims'],
		cells: [{ industry: 'insurance', department: 'claims', hasSpecialization: true }]
	});
	getOntology.mockResolvedValue({
		industry: 'insurance',
		department: 'claims',
		entities: [entity(OK_ID, 'Claim'), entity(FAIL_ID, 'Policy'), entity(NONE_ID, 'Adjuster')],
		relations: [],
		hidden: []
	});
	// ⛔ ONE entity's probe REJECTS; the other two answer. That mix is the whole point — a blanket
	// failure could be "fixed" by any change at all, and would not show that the healthy card is
	// left alone.
	listSamples.mockImplementation(async (id: string) => {
		if (id === FAIL_ID) throw new Error('probe failed');
		if (id === NONE_ID) return [] as EntitySample[];
		return [sample(true)];
	});
	deriveBlock.mockResolvedValue({ block: { slug: 'claim-data' } });
});
afterEach(() => {
	if (component) unmount(component);
	component = null;
	target.remove();
	vi.clearAllMocks();
});

describe('EntityDeriveBrowser tells the truth when a sample probe fails', () => {
	it('⛔ THE DEFECT: a failed probe renders as "no sample bound"', async () => {
		await browseCell();
		// The healthy neighbours prove the probe ran and the grid is real.
		expect(readiness('Claim'), 'the measured-ready entity lost its ready state').toBe(
			m.blockedit_derive_ready()
		);
		expect(readiness('Adjuster'), 'the measured-empty entity lost its no-sample state').toBe(
			m.blockedit_derive_no_sample()
		);

		expect(
			readiness('Policy'),
			'a card whose probe FAILED claims the author has no test data'
		).not.toContain(m.blockedit_derive_no_sample());
		expect(readiness('Policy'), 'the unknown state has no words of its own').toContain(
			mm.blockedit_derive_sample_unknown()
		);
	});

	it('⛔ …and the author is not silently blocked: Derive stays live, with a reason and a retry', async () => {
		await browseCell();
		card('Policy').dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle();

		expect(
			deriveButton().disabled,
			'a failed readiness probe disabled Derive — permanently, with no stated reason'
		).toBe(false);
		expect(
			previewText(),
			'the preview repeats the "bind a sample" instruction for data we never measured'
		).not.toContain(m.blockedit_derive_no_sample_help());
		expect(previewText(), 'the preview says nothing about the failed probe').toContain(
			mm.blockedit_derive_sample_unknown_help()
		);
		expect(
			target.querySelector('[data-testid="derive-sample-unknown"]'),
			'the unknown notice is not identifiable'
		).toBeTruthy();

		// A control that exists and does nothing is the defect in a fix's clothes: assert the
		// RE-REQUEST and the resulting state, not merely the button.
		const retry = [...target.querySelectorAll<HTMLButtonElement>('.preview button')].find(
			(b) => b.textContent?.trim() === m.error_load_retry()
		);
		expect(retry, '"Try again" names an action the screen does not offer').toBeTruthy();

		listSamples.mockImplementation(async () => [sample(true)]);
		const before = listSamples.mock.calls.length;
		retry!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle();

		expect(listSamples.mock.calls.length, 'the retry re-issued no request').toBe(before + 1);
		// ⚠️ ONLY the failed entity is re-probed — a retry that re-walks the whole cell would make
		// this an N-request button on a screen whose probe just proved it can fail.
		expect(listSamples).toHaveBeenLastCalledWith(FAIL_ID);
		expect(readiness('Policy'), 'a successful re-check left the card unknown').toBe(
			m.blockedit_derive_ready()
		);
		expect(previewText(), 'the unknown notice survived a successful re-check').not.toContain(
			mm.blockedit_derive_sample_unknown_help()
		);
	});

	it('⛔ THE OVER-CORRECTION GUARD: a MEASURED empty sample list still blocks and still says so', async () => {
		// Deleting the `hasPrimary` gate outright, or making every entity derivable, passes both
		// cases above forever. This is the half that reds on it.
		await browseCell();
		card('Adjuster').dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle();

		expect(
			deriveButton().disabled,
			'an entity with a measured-empty sample list became derivable'
		).toBe(true);
		expect(previewText(), 'the genuine no-sample help text was lost').toContain(
			m.blockedit_derive_no_sample_help()
		);
		expect(previewText(), 'a measured absence is reported as a failed probe').not.toContain(
			mm.blockedit_derive_sample_unknown_help()
		);
	});

	it('the healthy path is untouched: a bound primary sample derives', async () => {
		await browseCell();
		card('Claim').dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle();
		expect(deriveButton().disabled).toBe(false);
		deriveButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle();
		expect(deriveBlock).toHaveBeenCalledWith(OK_ID);
		expect(derived, 'onDerived never fired with the new block slug').toEqual(['claim-data']);
	});

	it('⛔ a failed probe does not blank the entity grid either', async () => {
		// The other wrong fix: letting the rejection out of `Promise.all` so it lands in
		// `loadEntities`' catch. That trades a small unknown for a large one — the entity grid
		// loaded perfectly and would be replaced by a load-error message.
		await browseCell();
		expect(cards().length, 'one failed sample probe tore down the whole entity grid').toBe(3);
		expect(
			target.querySelector('.banner.error'),
			'a decorative readiness probe raised a screen-level error'
		).toBeNull();
	});
});
