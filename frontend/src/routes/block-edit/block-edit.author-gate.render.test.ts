// @vitest-environment jsdom
//
// src/routes/block-edit/block-edit.author-gate.render.test.ts — the block editor had no role gate
// of any kind.
//
// ⛔ THE DEFECT. `editable` was `!slug || isDraft` — DRAFT STATE, not permission. So an ordinary
// member who typed `/block-edit` (or clicked a card in /blocks, which navigates here) got the whole
// authoring surface: a name/slug form and a Create button on the create path, and New draft / Save
// draft / Publish / Delete / Run tests / Simulate on an existing draft. Every one of them answers
// 403: `POST /api/blocks` is `requireBlockAuthor` (backend/src/routes/blocks.ts:561) and every
// per-block write goes through `authorizeBlockWrite` (:258). The nav table had ALREADY refused this
// href to a member (navConfig.ts:130) with a comment saying exactly why; the page itself never read
// that fact, so anyone who arrived by URL or by history walked straight past it.
//
// ⛔ WHAT IS **NOT** ASSERTED, DELIBERATELY: a whole-page denial. `GET /api/blocks/:slug` is bare
// `validateAuth` (blocks.ts:412) — the server lets any authenticated user READ a block, and /blocks
// is the catalog that links here. So the last case pins the opposite of the fix: a member still
// SEES the block. Only the controls the server would refuse are gone. A "deny the route" fix passes
// every other case in this file and reds on that one.
//
// ⛔ AND THE GLOBAL/TENANT SPLIT IS PINNED TOO. `authorizeBlockWrite` is super_admin-only for a
// PLATFORM block and developer-level for a tenant block, so a developer looking at a global block is
// in exactly the member's position. Collapsing the gate to a flat `isDeveloper` reds that case.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { BlockDetail, BlockTest, BlockVersion } from '$lib/types/blocks';

// Real `en` catalog, each key resolving to its own name (+ its arguments when it takes any).
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

const { nav, store, getBlock, listTests, lint } = vi.hoisted(() => ({
	// The route is keyed by `?slug=`; both modes of this screen are under test, so the URL moves.
	nav: { url: new URL('http://localhost/block-edit') },
	// Mutable across cases — the page reads `auth.user?.roles` (create mode) and the composite
	// getters (existing block), exactly as the real store exposes them.
	store: {
		auth: {
			user: null as { roles: string[] } | null,
			isDeveloper: false,
			isTenantAdmin: false,
			isSuperAdmin: false
		}
	},
	getBlock: vi.fn(),
	listTests: vi.fn(),
	lint: vi.fn()
}));

vi.mock('$app/state', () => ({
	page: {
		get url() {
			return nav.url;
		},
		params: {}
	}
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
// ⛔ ALIAS module ids, never relative ones.
vi.mock('$lib/api/blocks', () => ({
	ApiError: class ApiError extends Error {
		constructor(
			public status: number,
			public code = 'error',
			message = 'error',
			public findings?: unknown
		) {
			super(message);
		}
	},
	blocksApi: {
		get: getBlock,
		listTests,
		lint,
		saveVersion: vi.fn(),
		publish: vi.fn(),
		createVersion: vi.fn(),
		create: vi.fn(),
		remove: vi.fn(),
		streamTests: vi.fn(),
		createTest: vi.fn(),
		patchTest: vi.fn(),
		deleteTest: vi.fn()
	}
}));
vi.mock('$lib/api/datasets', () => ({ datasetsApi: { list: vi.fn().mockResolvedValue({ items: [] }) } }));
vi.mock('$lib/api/templates', () => ({ templatesApi: { create: vi.fn(), list: vi.fn() } }));
vi.mock('$lib/api/ontology', () => ({
	ApiError: class ApiError extends Error {},
	ontologyApi: {
		matrix: vi.fn().mockResolvedValue({ industries: [], departments: [], cells: [] }),
		get: vi.fn()
	}
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));
vi.mock('$lib/stores/auth.svelte', () => ({ auth: store.auth }));

import Page from './+page.svelte';

const SLUG = 'claims-triage';

/** The realm-role sets, with the composite getters resolved the way auth.svelte.ts derives them. */
const ROLES = {
	member: { user: { roles: ['member'] }, isDeveloper: false, isTenantAdmin: false, isSuperAdmin: false },
	developer: { user: { roles: ['developer'] }, isDeveloper: true, isTenantAdmin: false, isSuperAdmin: false },
	superAdmin: { user: { roles: ['super_admin'] }, isDeveloper: true, isTenantAdmin: true, isSuperAdmin: true }
} as const;
type Role = keyof typeof ROLES;

/** Every head/tab control on this screen that the API would refuse a non-author. */
const WRITES = [
	'blockedit_new_draft',
	'blockedit_save_draft',
	'blockedit_publish',
	'blockedit_delete'
] as const;

function version(): BlockVersion {
	return {
		id: 'v-draft-1',
		block_id: 'b1',
		version: '3',
		status: 'draft',
		language: 'typescript',
		docs_md: '# Claims triage',
		source_ts: 'export default function () {}',
		descriptor: { inputs: {}, outputs: {}, capabilities: { network: false } },
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

const TEST_ROW: BlockTest = {
	id: 't-1',
	name: 'triages a claim',
	description: null,
	inputs: {},
	datasets: [],
	expected: {},
	assert_mode: 'subset',
	expect_error: false,
	expected_error_kind: null,
	enabled: true,
	created_at: '2026-08-01T00:00:00Z',
	updated_at: '2026-08-01T00:00:00Z',
	last_result: null
};

function detail(owner: 'tenant' | 'global'): BlockDetail {
	return {
		id: 'b1',
		slug: SLUG,
		name: 'Claims triage',
		description: 'Triage a claim',
		category: 'logic',
		current_version_id: null,
		maintainer_id: null,
		owner,
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

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 24; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

function asRole(role: Role) {
	Object.assign(store.auth, ROLES[role]);
}

/** `/block-edit` with no slug — the create-new form. */
async function renderCreate(role: Role) {
	asRole(role);
	nav.url = new URL('http://localhost/block-edit');
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
}

/** `/block-edit?slug=…` on an existing DRAFT version — the maximal authoring surface. */
async function renderExisting(role: Role, owner: 'tenant' | 'global' = 'tenant') {
	asRole(role);
	nav.url = new URL(`http://localhost/block-edit?slug=${SLUG}`);
	getBlock.mockResolvedValue(detail(owner));
	// One real test row: "Run all" is `disabled` on an empty suite for an unrelated reason, so an
	// empty fixture would make the developer half of the Testing case vacuous.
	listTests.mockResolvedValue({ items: [TEST_ROW], total: 1, version_id: 'v-draft-1' });
	lint.mockResolvedValue({ findings: [] });
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
	// ⛔ POSITIVE ANCHOR. A page still on its load skeleton answers every "…is absent" for free.
	expect(host.querySelector('h1')?.textContent, 'the block never loaded').toBe('Claims triage');
}

const labels = () => [...host.querySelectorAll('button')].map((b) => b.textContent?.trim());
const tabLabels = () => [...host.querySelectorAll('.tabs .tab')].map((b) => b.textContent?.trim());

/** Switch to a tab by its message key. ⛔ `bubbles: true` — Svelte 5 delegates to the mount root. */
async function openTab(key: string) {
	const tab = [...host.querySelectorAll<HTMLButtonElement>('.tabs .tab')].find(
		(b) => b.textContent?.trim() === key
	);
	expect(tab, `the ${key} tab is missing — this case tests nothing`).toBeDefined();
	tab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await settle();
}

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	getBlock.mockReset();
	listTests.mockReset();
	lint.mockReset();
	Object.assign(store.auth, {
		user: null,
		isDeveloper: false,
		isTenantAdmin: false,
		isSuperAdmin: false
	});
});

describe('/block-edit CREATE mode', () => {
	it('⛔ THE DEFECT: a member got the create form whose only button 403s', async () => {
		await renderCreate('member');
		expect(labels(), 'the Create button renders for a member').not.toContain('blockedit_create_block');
		expect(
			host.querySelector('input.name-input'),
			'the member is still handed the authoring form'
		).toBeNull();
		// The refusal is the server's own, in the reader's language, with the way back.
		expect(host.textContent).toContain('error_developer_required');
		expect(host.querySelector('.notice.error a')?.getAttribute('href')).toBe('/blocks');
	});

	it('A DEVELOPER STILL GETS THE FORM — the over-correction guard', async () => {
		// ⛔ Denying create outright passes the case above forever; this is the half that reds on it.
		await renderCreate('developer');
		expect(host.querySelector('input.name-input'), 'the author lost the create form').not.toBeNull();
		expect(labels()).toContain('blockedit_create_block');
		expect(host.textContent).not.toContain('error_developer_required');
	});
});

describe('/block-edit on an EXISTING draft', () => {
	it('⛔ THE DEFECT: a member got New draft, Save draft, Publish and Delete', async () => {
		await renderExisting('member');
		for (const key of WRITES) {
			expect(labels(), `${key} renders for a member and answers 403 on click`).not.toContain(key);
		}
	});

	it('…and Simulate, a tab on which every control writes, is not offered either', async () => {
		await renderExisting('member');
		expect(tabLabels(), 'the Simulate tab is offered to a reader who cannot run it').not.toContain(
			'blockedit_tab_simulate'
		);
		// Testing stays — listing a suite is `validateAuth` — but its run/edit controls do not.
		expect(tabLabels()).toContain('blockedit_tab_testing');
	});

	it('…and the Testing tab lists the suite but offers no run, add, edit or delete', async () => {
		// Listing a suite is `validateAuth` (blocks.ts:683) so the RESULTS stay readable, but the run
		// itself and every mutation are `authorizeBlockWrite` (:864, :725, :769, :814). "Run all" was
		// never gated at all before this — not even on `isDraft`.
		await renderExisting('member');
		await openTab('blockedit_tab_testing');
		expect(host.textContent, 'the suite never loaded, so this case tests nothing').toContain(
			TEST_ROW.name
		);
		for (const key of ['blockedit_test_run_all', 'blockedit_test_add', 'blockedit_test_edit', 'blockedit_test_delete']) {
			expect(labels(), `${key} renders for a reader who cannot write this block`).not.toContain(key);
		}

		unmount(app!);
		app = null;
		host.textContent = '';
		getBlock.mockReset();
		listTests.mockReset();

		// ⛔ The over-correction half, in the same case so the pair cannot drift apart.
		await renderExisting('developer');
		await openTab('blockedit_tab_testing');
		expect(labels(), 'the author lost the run control').toContain('blockedit_test_run_all');
		expect(labels()).toContain('blockedit_test_add');
	});

	it('…and the form fields are read-only, not merely un-saveable', async () => {
		// `editable` drives the whole authoring surface. Permissions & data is the cheapest honest
		// probe of it (four capability toggles, no CodeMirror in the way).
		//
		// ⛔ THE TOGGLES ARE NAMED, NOT COUNTED, AND THAT IS A DELIBERATE DOWNGRADE FROM `toBe(n)`.
		// This assertion used to be `expect(toggles.length).toBe(3)`, which went stale the moment
		// `dataset` was split out of `mockData` (migration 0077) and became `toBe(4)`. A bare count is
		// the weakest possible guard: it reds on ADDING a control but passes silently if a toggle is
		// RENAMED, REPLACED, or REORDERED, and the `toEqual([true, …])` beside it says nothing about
		// WHICH capability each `true` belongs to.
		//
		// ⛔ THREE, NOT FOUR, AND THE MISSING ONE IS A DELETION THIS FILE HAS TO RECORD RATHER THAN
		// ABSORB. `network` was removed as an interactive control (a101ea8): there is no `ctx.fetch`,
		// and `capabilities.network`'s only reader — `host/run-policy.ts:71-74` — uses the bit to
		// REFUSE the run, so the switch granted nothing and bought the author a flow that will not
		// execute. Shrinking this array from four names to three is therefore the CORRECT update, and
		// the shrink is pinned rather than shrugged at: the row itself still renders (asserted below),
		// so "the toggle went away" and "the whole row went away" stay distinguishable. If `ctx.fetch`
		// is ever built, the toggle comes back and this array goes back to four.
		//
		// ⚠️ AND IT CANNOT BE DERIVED, WHICH IS WHY IT IS SPELLED OUT. There is NO runtime list of
		// capability keys anywhere in this repo — verified: `db/block-types.ts` exports `as const`
		// arrays for `BLOCK_CATEGORIES`, `BLOCK_STATUSES`, `ASSERT_MODES` and three more, but
		// `BlockCapabilities` (:58) is a TYPE ONLY. The four keys are re-spelled by hand in six
		// independent places — that interface, `blocks/descriptor-schema.ts`, `ai/block-catalog-
		// service.ts`, two LLM prompt strings in `db/seed-ai.ts`, `$lib/types/blocks.ts`, and this
		// page (`+page.svelte:146`, `:264`, `:535-551`, plus four hand-written `<div class="toggle-
		// row">` markup blocks — three carrying a `button.toggle`, one carrying the static
		// `network` row; the sibling `.io` block DOES use `{#each}`, so the pattern was available and
		// not taken). With no single source to iterate,
		// deriving the expectation would mean re-listing the keys in this file anyway — so it lists
		// them where a reader can see them, keyed to the `aria-label` each button actually carries.
		//
		// ⛔ WHAT THIS CASE DOES **NOT** CHECK, AND WHERE THAT LIVES — DO NOT DELETE THE SIBLING AS A
		// DUPLICATE. `aria-label` proves a button with that NAME exists and is gated; it says nothing
		// about which capability the button is WIRED to. Measured: rewiring the dataset button to
		// `class:on={caps.mockData}` / `onclick={() => (caps.mockData = !caps.mockData)}` while
		// leaving `aria-label={m.blockedit_cap_dataset()}` alone leaves this file fully GREEN
		// (10 passed) — and reds `block-edit.capability-toggles.render.test.ts` (4 failed | 1 passed),
		// which drives each toggle and reads back the descriptor. That file is the load-bearing half
		// of this pair: this one owns the AUTHOR GATE, that one owns the BINDING.
		//
		// A FIFTH CAPABILITY REDS THIS. `toEqual` on the mapped array fails on an extra element, a
		// missing one, a rename, and a reorder alike — and the failure prints the capability that
		// moved rather than `expected 4, got 5`. If you add one: extend BOTH arrays, and satisfy
		// yourself the new button carries `disabled={!editable}`. An ungated toggle lets a member flip
		// a capability on a block the server will 403 their save of.
		await renderExisting('member');
		await openTab('blockedit_tab_permissions');
		const toggles = [...host.querySelectorAll<HTMLButtonElement>('.perms button.toggle')];
		expect(
			toggles.map((t) => t.getAttribute('aria-label')),
			'the capability toggles rendered, but not the ones this case is about'
		).toEqual(['blockedit_cap_llm', 'blockedit_cap_mock', 'blockedit_cap_dataset']);
		expect(
			toggles.map((t) => t.disabled),
			'a member can still flip the capability toggles of a block they cannot save'
		).toEqual([true, true, true]);

		// ⛔ THE OTHER HALF OF THE SHRINK ABOVE, AND IT IS WHAT KEEPS `toEqual` HONEST. Without this,
		// deleting the network ROW outright — label, sub-label and explanation — would pass the three
		// names above silently, and the author would be left with a capability that vanished from the
		// screen without ever being told why their `network:true` block refuses to run. The row stays;
		// only the switch went.
		const unavailable = host.querySelector('[data-testid="cap-network-unavailable"]');
		expect(
			unavailable,
			'the network row vanished entirely — the toggle list shrinking to three is only correct ' +
				'while the row survives and says why'
		).not.toBeNull();
		// ⚠️ NOT A `disabled` BUTTON. A greyed switch says "not yet" / "not for you" and sends the
		// author looking for the permission that unlocks it; there is none. So there is nothing here
		// for the author gate to gate, which is why this row contributes no entry to either array.
		expect(
			unavailable!.closest('.toggle-row')!.querySelector('button'),
			'the network row grew a button back — it belongs in the arrays above if it did'
		).toBeNull();
	});

	it('A DEVELOPER STILL GETS ALL OF IT — the over-correction guard', async () => {
		// ⛔ `{#if false}` passes every case above forever; this is the half that reds on it.
		await renderExisting('developer');
		for (const key of WRITES) {
			expect(labels(), `${key} disappeared for the developer who owns this tenant block`).toContain(
				key
			);
		}
		expect(tabLabels()).toContain('blockedit_tab_simulate');
	});

	it('a GLOBAL block refuses the same developer — the gate is not a flat isDeveloper', async () => {
		// `authorizeBlockWrite` (blocks.ts:262): a platform block with `tenant_id NULL` is
		// super_admin-only. `canDelete` already carried this split; the rest of the screen did not.
		await renderExisting('developer', 'global');
		for (const key of WRITES) {
			expect(labels(), `${key} renders on a PLATFORM block for a plain developer`).not.toContain(key);
		}
		await settle();
	});

	it('…while a super admin authors that same global block', async () => {
		await renderExisting('superAdmin', 'global');
		for (const key of WRITES) {
			expect(labels(), `${key} disappeared for the platform admin who owns it`).toContain(key);
		}
	});

	it('THE READ SURVIVES: a member still sees the block they are entitled to read', async () => {
		// ⛔ `GET /api/blocks/:slug` is bare `validateAuth` (blocks.ts:412), and /blocks links here.
		// Refusing the whole route would pass every case above and take away a read the server grants.
		await renderExisting('member');
		expect(host.querySelector('h1')?.textContent).toBe('Claims triage');
		expect(host.textContent, 'the member was denied a read the API allows').not.toContain(
			'error_developer_required'
		);
		expect(tabLabels().length, 'the member lost the block entirely').toBeGreaterThan(3);
	});
});
