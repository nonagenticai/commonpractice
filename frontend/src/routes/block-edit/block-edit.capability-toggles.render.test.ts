// @vitest-environment jsdom
//
// src/routes/block-edit/block-edit.capability-toggles.render.test.ts — the block editor must let an
// author grant `capabilities.dataset` WITHOUT claiming the block's output is invented.
//
// ⛔ THE DEFECT, AND IT IS A HOLE RATHER THAN A WRONG LINE. `mockData` used to mean two things at
// once: "this block fabricates sample data" (the claim every "Simulated" badge renders from) AND
// "this block may read the tenant's REAL datasets via ctx.dataset()" (the executor's gate). The
// split moved the second meaning to `capabilities.dataset` — in the type, the runtime gate, the
// seeds and a migration — and the editor round-tripped the new bit so an EXISTING dataset block kept
// its grant across a save. But the Permissions & data tab grew no control for it. So an author
// writing a NEW block that calls `ctx.dataset()` still had exactly one reachable option: tick
// "mock data" — which re-created the overload the split removed and re-earned the false badge on a
// block returning the customer's own rows. A capability nobody can set does not exist for new work.
//
// ⛔ WHY THIS FILE DRIVES THE SAVE AND THEN MOUNTS THE CANVAS NODE. Asserting "the toggle flips a
// rune" proves nothing about the defect: the defect is a WORD ON A CUSTOMER'S SCREEN. The property
// that matters spans two components — what the editor SENDS (`buildDescriptor()` → the descriptor
// `saveVersion` receives) and what a reader then SEES rendered off that same descriptor. So each
// case ticks a real toggle, clicks the real "Save draft", takes the capability bag the API was
// actually called with, and mounts the real `BlockNode` with it. Nothing is retyped by hand between
// the two halves — the badge is read off the editor's own output.
//
// ⚠️ Sibling coverage, deliberately not duplicated here: `block-simulated-badge.surfaces.render.
// test.ts` sweeps the four presentation surfaces from hand-written capability bags. This file is the
// AUTHORING half — that the bag a developer can produce through the product is the right one.
//
// ⚠️ `@xyflow/svelte` is stubbed for the node (its `Handle` needs a SvelteFlow store context a bare
// `mount` cannot provide, and the handles draw no text). Messages resolve to their own KEY NAMES:
// the subject here is which bit is bound to which control, not the wording — the wording is
// `catalogs.test.ts` / `placeholder-parity.test.ts` business.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { BlockDetail, BlockVersion } from '$lib/types/blocks';
import type { BlockNodeData } from '$lib/stores/builder.svelte';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')
	) as Record<string, string>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = (params?: Record<string, unknown>) =>
			params && Object.keys(params).length ? `${key}:${Object.values(params).join(',')}` : key;
	}
	return mod;
});

vi.mock('@xyflow/svelte', () => ({
	Handle: () => ({}),
	Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' }
}));

// ⚠️ THE SLUG IS SPELLED OUT, NOT INTERPOLATED. `vi.mock` factories hoist above every `const`, so a
// reference to one throws at import time and the file collects ZERO tests while looking green.
vi.mock('$app/state', () => ({
	page: { url: new URL('http://localhost/block-edit?slug=row-counter'), params: {} }
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

const { getBlock, lint, saveVersion } = vi.hoisted(() => ({
	getBlock: vi.fn(),
	lint: vi.fn(),
	saveVersion: vi.fn()
}));
// ⛔ ALIAS module ids, never relative ones — and `ApiError` must be a real class: the page branches
// on `e instanceof ApiError` in several catches and a plain object silently reroutes them.
vi.mock('$lib/api/blocks', () => ({
	ApiError: class ApiError extends Error {
		constructor(
			public status: number,
			public code = 'error',
			message = 'error',
			public details?: Record<string, unknown>,
			public findings?: unknown
		) {
			super(message);
		}
	},
	blocksApi: {
		get: getBlock,
		lint,
		saveVersion,
		publish: vi.fn(),
		createVersion: vi.fn(),
		create: vi.fn(),
		remove: vi.fn()
	}
}));
vi.mock('$lib/api/templates', () => ({ templatesApi: { create: vi.fn(), list: vi.fn() } }));
vi.mock('$lib/api/ontology', () => ({
	ApiError: class ApiError extends Error {},
	ontologyApi: {
		matrix: vi.fn().mockResolvedValue({ industries: [], departments: [], cells: [] }),
		get: vi.fn()
	}
}));
// A developer of the OWNING tenant — `canAuthor`, and the version below is a draft, so `editable`
// is true and the toggles are live. A reader gets `disabled` toggles and could not test this.
vi.mock('$lib/stores/auth.svelte', () => ({
	auth: { isDeveloper: true, isSuperAdmin: false, isTenantAdmin: false, user: { roles: ['developer'] } }
}));

import Page from './+page.svelte';
import BlockNode from '$lib/components/build/BlockNode.svelte';

const SLUG = 'row-counter';

/** The loaded draft declares NEITHER bit — both toggles start off, so a flip is unambiguous. */
function version(): BlockVersion {
	return {
		id: 'v1',
		block_id: 'b1',
		version: '1',
		status: 'draft',
		language: 'typescript',
		docs_md: '# Row counter',
		source_ts: 'export default { async run() { return {}; } };',
		descriptor: {
			inputs: { source: { type: 'dataset', required: true } },
			outputs: { count: { type: 'number' } },
			capabilities: { network: false }
		},
		examples: [],
		changelog: '',
		tests_passing: true,
		usage_count: 0,
		published_by: null,
		published_at: null,
		created_at: '2026-08-01T00:00:00.000Z',
		author: null
	};
}

function detail(): BlockDetail {
	return {
		id: 'b1',
		slug: SLUG,
		name: 'Row counter',
		description: 'Counts the rows of a workspace dataset.',
		category: 'data',
		current_version_id: null,
		maintainer_id: null,
		owner: 'tenant',
		region: null,
		cost_class: null,
		license: null,
		archived: false,
		created_at: '2026-08-01T00:00:00.000Z',
		updated_at: '2026-08-01T00:00:00.000Z',
		maintainer: null,
		versions: [version()]
	} as BlockDetail;
}

let target: HTMLElement;
let component: Record<string, unknown> | null = null;
let nodeHost: HTMLElement | null = null;
let nodeApp: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

/** A toggle is addressed the way a screen reader addresses it — by its `aria-label`. */
function toggle(key: string): HTMLButtonElement | null {
	return target.querySelector<HTMLButtonElement>(`button.toggle[aria-label="${key}"]`);
}
function isOn(key: string): boolean {
	return toggle(key)?.classList.contains('on') ?? false;
}
/** Clicks a button by its rendered label. `.click()` bubbles, which Svelte 5's delegation needs. */
function clickByText(text: string): void {
	const btn = [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
	expect(btn, `no button labelled "${text}" is on screen`).toBeTruthy();
	btn!.click();
	flushSync();
}

async function openPermissionsTab() {
	getBlock.mockResolvedValue(detail());
	lint.mockResolvedValue({ ok: true, findings: [] });
	saveVersion.mockImplementation(async () => version());
	component = mount(Page, { target }) as Record<string, unknown>;
	await settle();
	// ⛔ THE POSITIVE MARKER. /block-edit mounts a dozen components; one that throws and every
	// "the badge is absent" assertion below passes against an empty DOM.
	expect(
		target.querySelector('header.edit-head'),
		'the editor never rendered, so this file tests nothing'
	).not.toBeNull();
	clickByText('blockedit_tab_permissions');
	await settle();
	expect(target.querySelector('.perms'), 'the Permissions & data tab did not open').not.toBeNull();
}

/** The capability bag `buildDescriptor()` actually put on the wire. */
function savedCapabilities(): Record<string, unknown> {
	expect(saveVersion, 'Save draft never reached the API').toHaveBeenCalledTimes(1);
	const body = saveVersion.mock.calls[0]![2] as { descriptor: { capabilities: Record<string, unknown> } };
	return body.descriptor.capabilities;
}

/**
 * Mount the real canvas node on the descriptor the EDITOR produced — not on a hand-written bag.
 * Returns the badge texts found (`.cp-node-sim` is the node's "Simulated" pill).
 */
function badgesForSavedDescriptor(): string[] {
	const data: BlockNodeData = {
		blockId: 'b1',
		blockVersionId: 'v1',
		slug: SLUG,
		label: 'Row counter',
		category: 'data',
		descriptor: {
			inputs: { source: { type: 'dataset', required: true } },
			outputs: { count: { type: 'number' } },
			capabilities: savedCapabilities()
		},
		config: {}
	} as unknown as BlockNodeData;
	nodeHost = document.createElement('div');
	document.body.appendChild(nodeHost);
	nodeApp = mount(BlockNode, { target: nodeHost, props: { data, selected: false } as never }) as Record<string, unknown>;
	flushSync();
	// NON-VACUITY: the node really rendered, so an empty `[]` below means "no badge", not "no node".
	expect(nodeHost.querySelectorAll('.cp-node-head'), 'the canvas node rendered no head').toHaveLength(1);
	return [...nodeHost.querySelectorAll('.cp-node-sim')].map((n) => n.textContent?.trim() ?? '');
}

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
});
afterEach(() => {
	if (nodeApp) unmount(nodeApp);
	nodeApp = null;
	nodeHost?.remove();
	nodeHost = null;
	if (component) unmount(component);
	component = null;
	target.remove();
	flushSync();
	getBlock.mockReset();
	lint.mockReset();
	saveVersion.mockReset();
});

describe('the block editor can grant capabilities.dataset without claiming simulation', () => {
	it('⛔ the Permissions & data tab exposes a dataset toggle beside the mock-data one', async () => {
		await openPermissionsTab();
		// The neighbour proves the selector works at all — without it, "the dataset toggle is
		// missing" and "this query matches nothing ever" look identical.
		expect(toggle('blockedit_cap_mock'), 'the mock-data toggle is missing').not.toBeNull();
		expect(
			toggle('blockedit_cap_dataset'),
			'there is no control to GRANT capabilities.dataset, so a new ctx.dataset() block can only ' +
				'be authored by ticking mock data — the overload the split exists to remove'
		).not.toBeNull();
		// Both start off: every flip below is caused by the click, not inherited from the fixture.
		expect(isOn('blockedit_cap_dataset')).toBe(false);
		expect(isOn('blockedit_cap_mock')).toBe(false);
		// The toggle is live for someone who may write. A `disabled` control grants nothing.
		expect(toggle('blockedit_cap_dataset')!.disabled, 'the dataset toggle is disabled for its author').toBe(false);
	});

	it('⛔⛔ ticking dataset ALONE saves dataset:true, never mockData — and the node is NOT badged', async () => {
		await openPermissionsTab();
		toggle('blockedit_cap_dataset')!.click();
		flushSync();

		// Bound to `caps.dataset`, not to `caps.mockData`: the neighbour did not move.
		expect(isOn('blockedit_cap_dataset'), 'the dataset toggle did not flip').toBe(true);
		expect(
			isOn('blockedit_cap_mock'),
			'the dataset toggle is bound to caps.mockData — the exact overload this control removes'
		).toBe(false);

		clickByText('blockedit_save_draft');
		await settle();

		const caps = savedCapabilities();
		expect(caps.dataset, 'the grant never reached the descriptor').toBe(true);
		// ⛔ ABSENT, not `false`. `buildDescriptor()` omits an unticked optional bit, and the badge
		// reads `mockData === true`; asserting `not.toBe(true)` would also pass on `mockData: true`
		// spelled some other way, so pin the key itself.
		expect(caps).not.toHaveProperty('mockData');

		// ⛔⛔ THE WHOLE POINT, read off the editor's own output: a block granted access to the
		// workspace's REAL rows must not be labelled a simulation on the canvas the customer watches.
		expect(badgesForSavedDescriptor()).toEqual([]);
	});

	it('⛔ ticking mock data ALONE still saves mockData:true — and the node IS badged', async () => {
		// The other half of the discriminator. Without it, "never badge anything" and "bind both
		// toggles to dataset" both pass the case above, and the honesty work 0076 shipped is undone.
		await openPermissionsTab();
		toggle('blockedit_cap_mock')!.click();
		flushSync();

		expect(isOn('blockedit_cap_mock'), 'the mock-data toggle did not flip').toBe(true);
		expect(
			isOn('blockedit_cap_dataset'),
			'the mock-data toggle is bound to caps.dataset — the bits are swapped'
		).toBe(false);

		clickByText('blockedit_save_draft');
		await settle();

		const caps = savedCapabilities();
		expect(caps.mockData, 'the fabrication claim never reached the descriptor').toBe(true);
		expect(caps).not.toHaveProperty('dataset');

		expect(badgesForSavedDescriptor()).toEqual(['block_simulated_badge']);
	});

	it('⛔ ticking BOTH keeps both bits — dataset access never cancels a fabrication claim', async () => {
		await openPermissionsTab();
		toggle('blockedit_cap_dataset')!.click();
		toggle('blockedit_cap_mock')!.click();
		flushSync();

		clickByText('blockedit_save_draft');
		await settle();

		const caps = savedCapabilities();
		expect(caps.dataset).toBe(true);
		expect(caps.mockData).toBe(true);
		// A block that genuinely reads a dataset AND invents part of its output is honestly simulated.
		expect(badgesForSavedDescriptor()).toEqual(['block_simulated_badge']);
	});

	it('⛔ an EXISTING dataset grant arrives ON, so a save cannot silently drop it', async () => {
		// The round-trip half (`selectVersion` → `caps` → `buildDescriptor`) now has a visible face:
		// if the toggle were wired to a fresh local flag instead of the descriptor's bit, a developer
		// opening `load-dataset` would see an UNTICKED box and save the grant away.
		getBlock.mockResolvedValue({
			...detail(),
			versions: [
				{
					...version(),
					descriptor: {
						...version().descriptor,
						capabilities: { network: false, dataset: true }
					}
				}
			]
		} as BlockDetail);
		lint.mockResolvedValue({ ok: true, findings: [] });
		saveVersion.mockImplementation(async () => version());
		component = mount(Page, { target }) as Record<string, unknown>;
		await settle();
		clickByText('blockedit_tab_permissions');
		await settle();

		expect(toggle('blockedit_cap_dataset'), 'the dataset toggle is missing').not.toBeNull();
		expect(isOn('blockedit_cap_dataset'), 'the saved grant did not reach the toggle').toBe(true);
		expect(isOn('blockedit_cap_mock')).toBe(false);
	});
	// ─────────────────────────────────────────────────────────────────────────────────────────────
	// ⛔ THE SECOND DEFECT ON THIS TAB: a toggle that granted nothing and could get a flow refused.
	//
	// There is no `ctx.fetch`. `backend/src/exec/sdk.ts`'s `BlockContext` exposes `llm`, `mockData`,
	// `dataset`, `log` and `signal`; `backend/src/exec/static-scan.ts` refuses `fetch` /
	// `XMLHttpRequest` at SAVE time. The ONLY reader of `capabilities.network` anywhere is
	// `backend/src/host/run-policy.ts`, which uses it to REFUSE the run. So the control labelled
	// "Netwerktoegang" bought the author no capability at all and handed them a flow that will not
	// execute — a switch that reads as a grant and behaves as a self-inflicted ban.
	//
	// ⛔ THE FIELD IS KEPT AND THE CONTROL IS REMOVED, WHICH IS WHY THE THIRD CASE BELOW EXISTS.
	// Hardcoding `network:false` on save would silently downgrade a legacy `network:true` row the
	// moment any developer opened this tab and pressed Save, and would quietly change what
	// `run-policy` decides about that block. Round-tripping is the honest half of the fix and it is
	// invisible on screen — so it is asserted against the descriptor the API is actually called with.
	describe('the network capability is no longer offered as a grant', () => {
		it('⛔ THE DEFECT: an interactive network control exists at all', async () => {
			await openPermissionsTab();
			expect(
				toggle('blockedit_cap_network'),
				'the Permissions tab still offers to GRANT a capability the sandbox does not have, ' +
					'and whose only effect is to make host/run-policy.ts refuse the run'
			).toBeNull();
			// ⚠️ AND NOT AS A DISABLED ONE EITHER. A greyed switch says "not yet" or "not for you",
			// which sends the author looking for the permission that unlocks it. There is none.
			expect(
				target.querySelectorAll('.perms button.toggle'),
				'a disabled toggle is still a toggle'
			).toHaveLength(3);
		});

		it('the row survives and says why, in the reader’s language', async () => {
			await openPermissionsTab();
			const row = target.querySelector('[data-testid="cap-network-unavailable"]');
			expect(row, 'the capability vanished silently — an author is left wondering').not.toBeNull();
			expect(row!.textContent).toContain('blockedit_cap_network_unavailable');
			// The label stays: the capability is still a thing the descriptor can carry, and an author
			// reading a legacy block needs the word to make sense of it.
			expect(target.querySelector('.perms')!.textContent).toContain('blockedit_cap_network');
		});

		it('⛔ a legacy network:true block still SAVES network:true — the field round-trips', async () => {
			// ⛔ THE OVER-CORRECTION GUARD. Removing the control and hardcoding `network:false` on save
			// looks like the same fix and is not: it rewrites a bit this change has no authority over,
			// on somebody else's block, as a side effect of opening a tab.
			getBlock.mockResolvedValue({
				...detail(),
				versions: [
					{
						...version(),
						descriptor: { ...version().descriptor, capabilities: { network: true } }
					}
				]
			} as BlockDetail);
			lint.mockResolvedValue({ ok: true, findings: [] });
			saveVersion.mockImplementation(async () => version());
			component = mount(Page, { target }) as Record<string, unknown>;
			await settle();
			clickByText('blockedit_tab_permissions');
			await settle();
			expect(target.querySelector('.perms'), 'the Permissions & data tab did not open').not.toBeNull();

			clickByText('blockedit_save_draft');
			await settle();

			expect(
				savedCapabilities().network,
				'opening the tab and saving silently revoked a legacy grant'
			).toBe(true);
		});

		it('…and a network:false block still saves network:false, not an absent key', async () => {
			// The other half: `buildDescriptor` spells this bit EXPLICITLY (unlike llm/mockData/dataset,
			// which are omitted when off). Dropping to an absent key would change what an older backend
			// reading `capabilities.network ?? …` decides. The fixture's own descriptor is network:false.
			await openPermissionsTab();
			clickByText('blockedit_save_draft');
			await settle();
			expect(savedCapabilities()).toHaveProperty('network', false);
		});
	});
});
