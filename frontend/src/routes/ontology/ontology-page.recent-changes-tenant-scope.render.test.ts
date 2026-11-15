// @vitest-environment jsdom
//
// src/routes/ontology/ontology-page.recent-changes-tenant-scope.render.test.ts — the browser half of
// WS-4: this page must read the TENANT-SCOPED changes route, and it must say so when that route
// hid something.
//
// ⛔ THE DEFECT. `loadChanges()` called
//
//     auditApi.list({ category: 'data', q: 'ontology', range: '30d' })
//
// — the PLATFORM audit feed, the same endpoint /audit renders. It has no tenant predicate and none
// is possible: `audit_log` has no `tenant_id` column and sits outside RLS by design (migration
// 0028), because being the one cross-tenant record is its job. So a super_admin opening /ontology —
// including one scope-switched into a customer workspace via `X-Active-Tenant-Id` — read EVERY
// other tenant's ontology history in a panel captioned "Recent changes", under a graph that IS
// tenant-scoped. Reproduced against a live stack before the fix: an operator acting into the demo
// tenant saw another tenant's "Custom entity 'rival_margin_secret'" as the top row.
//
// ⛔⛔ THIS FILE DOES NOT — AND CANNOT — PROVE THE SCOPING ITSELF. The attribution is a SQL join
// against `ontology_entities.tenant_id` / `audit_log.metadata->>'tenantId'`; a mocked client can
// only ever return what the test told it to. `backend/tests/ontology-changes-tenant-scope.test.ts`
// is the proof, against two real tenants in Postgres. What lives HERE is the half a backend test
// cannot see:
//   1. the page asks the SCOPED route and never `auditApi` — the client-side half of the leak;
//   2. when the route hid rows, the screen SAYS SO — this repo has shipped
//      "absent collapsed into empty" repeatedly and a silent filter is the same defect wearing a
//      security fix's clothes;
//   3. ⛔ and the workspace's OWN rows still render. A "fix" that returned nothing at all would
//      satisfy (1) and (2) and be a worse product than the leak; asserting only the absence of the
//      other tenant's row is the vacuous test this repo keeps catching.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { AuditItem } from '$lib/types/audit';
import type { CompiledOntology, MatrixData } from '$lib/types/ontology';

// Real `en` catalog, each key resolving to its own name (params appended) — same seam as the
// sibling failure spec, so a missing message key reds rather than silently rendering nothing.
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

const { matrixFn, getOntology, recentChangesFn, auditList, FakeApiError } = vi.hoisted(() => ({
	matrixFn: vi.fn(),
	getOntology: vi.fn(),
	recentChangesFn: vi.fn(),
	// ⛔ REGISTERED PURELY TO BE PROVEN UNCALLED. If a later change routes this panel back through
	// the platform feed, `auditList` records the call and the first test below reds with the reason.
	auditList: vi.fn(),
	FakeApiError: class FakeApiError extends Error {
		constructor(
			public status: number,
			public code = 'error',
			message = 'error'
		) {
			super(message);
		}
	}
}));
vi.mock('$lib/api/ontology', () => ({
	ApiError: FakeApiError,
	ontologyApi: {
		matrix: matrixFn,
		get: getOntology,
		recentChanges: recentChangesFn,
		createEntity: vi.fn(),
		updateEntity: vi.fn(),
		deleteEntity: vi.fn(),
		createRelation: vi.fn(),
		deleteRelation: vi.fn(),
		hideEntity: vi.fn(),
		unhideEntity: vi.fn(),
		translations: vi.fn(),
		saveTranslations: vi.fn(),
		samples: vi.fn(),
		saveSample: vi.fn(),
		deleteSample: vi.fn()
	}
}));
vi.mock('$lib/api/audit', () => ({ ApiError: FakeApiError, auditApi: { list: auditList } }));
vi.mock('$lib/api/datasets', () => ({
	datasetsApi: { list: vi.fn().mockResolvedValue({ items: [] }), get: vi.fn() }
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));

import Page from './+page.svelte';
// The changes route is `requireSuperAdmin`, and the page only asks it for a super_admin.
import { auth } from '$lib/stores/auth.svelte';

function matrix(): MatrixData {
	return {
		industries: ['Insurance'],
		departments: ['Claims'],
		cells: [{ industry: 'Insurance', department: 'Claims', hasSpecialization: true }],
		canManage: false
	} as MatrixData;
}

function ontology(): CompiledOntology {
	return {
		industry: 'Insurance',
		department: 'Claims',
		entities: [],
		relations: [],
		hidden: [],
		canManage: false
	} as CompiledOntology;
}

function change(id: string, actor: string): AuditItem {
	return {
		id,
		action: 'ontology.entity_create',
		category: 'data',
		targetType: 'ontology_entity',
		targetId: '3f1c0000-0000-4000-8000-00000000a8b2',
		result: 'ok',
		resultTone: 'ok',
		createdAt: '2026-08-14T09:00:00.000Z',
		actor: { name: actor, initials: 'MV' }
	};
}

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 16; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

async function render() {
	matrixFn.mockResolvedValue(matrix());
	getOntology.mockResolvedValue(ontology());
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
}

/** The anti-vacuity gate from the sibling spec: the panel lives inside `{#if ontology}`, so a page
 *  stuck in its loading branch renders no panel and every "is not shown" assertion passes for free. */
function assertGraphLoaded() {
	expect(recentChangesFn, 'the changes feed was never requested').toHaveBeenCalled();
	expect(
		host.querySelector('.graph-col'),
		'the ontology page never left its loading branch'
	).not.toBeNull();
	expect(host.textContent, 'the graph column did not render').toContain('ontology_click_entity');
}

beforeEach(() => {
	auth.user = { roles: ['super_admin'] } as never;
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	auth.user = null;
	if (app) unmount(app);
	app = null;
	host.remove();
	for (const fn of [matrixFn, getOntology, recentChangesFn, auditList]) fn.mockReset();
});

describe('/ontology "Recent changes" reads the workspace-scoped route, and admits what it hid', () => {
	it('⛔ asks the SCOPED changes route — never the platform audit feed', async () => {
		// REVERT THAT TURNS THIS RED: put `auditApi.list({ category: 'data', q: 'ontology' })` back in
		// `loadChanges`. `recentChangesFn` is then never called (assertGraphLoaded reds) and
		// `auditList` is (the second assertion reds). Both halves matter: calling BOTH would leak
		// just as thoroughly as calling only the old one.
		recentChangesFn.mockResolvedValue({ items: [change('a1', 'Mary de Vries')], unattributed: 0 });
		await render();
		assertGraphLoaded();
		expect(
			auditList,
			'/ontology called the PLATFORM audit feed — that feed has no tenant predicate and cannot have one'
		).not.toHaveBeenCalled();
	});

	it('⛔ hidden rows are DISCLOSED — and this workspace’s own rows still render beside them', async () => {
		// ⛔⛔ THE TWO HALVES ARE ONE TEST ON PURPOSE. Splitting them lets the negative half pass
		// against a panel that renders nothing at all, which is precisely the failure this codebase
		// keeps catching: a scoping fix that quietly empties the screen looks identical to a correct
		// one until someone asks where their own edits went.
		recentChangesFn.mockResolvedValue({
			items: [change('a1', 'Mary de Vries'), change('a2', 'Sam Submitter')],
			unattributed: 3
		});
		await render();
		assertGraphLoaded();

		const panel = host.querySelector('.changes');
		expect(panel, 'the panel vanished').not.toBeNull();

		// POSITIVE HALF — the workspace's own history is still on screen.
		expect(panel!.querySelectorAll('li'), 'this workspace’s own changes stopped rendering').toHaveLength(2);
		expect(panel!.textContent).toContain('Mary de Vries');
		expect(panel!.textContent).toContain('Sam Submitter');

		// DISCLOSURE HALF — the hiding is stated, with the count.
		// REVERT THAT TURNS THIS RED: delete the `{#if changesUnattributed > 0}` block. The rows above
		// still render, so ONLY this assertion moves — which is what makes it a real test of the
		// disclosure rather than of the panel.
		const note = panel!.querySelector('[data-testid="changes-unattributed"]');
		expect(note, 'rows were hidden and the screen said nothing about it').not.toBeNull();
		expect(note!.textContent).toContain('ontology_recent_changes_unattributed:3');
		// It is not an alert — nothing is broken; the panel is being honest about its completeness.
		expect(panel!.querySelector('[data-testid="changes-error"]')).toBeNull();
	});

	it('⛔ a workspace with ONLY hidden rows still gets the panel — silence would read as "nothing changed"', async () => {
		// ⛔ THE CASE THAT DEFEATS THE ONE-LINE FIX. Gating the panel on `recentChanges.length > 0`
		// (which is what it did for two releases) puts the disclosure inside a box that only renders
		// when there is nothing to disclose. A workspace whose only recent ontology work was a DELETE
		// — unattributable by construction, the target row is gone before the reader arrives — would
		// see the panel disappear and read that as a quiet month.
		// REVERT THAT TURNS THIS RED: drop `|| changesUnattributed > 0` from the `{:else if}`.
		recentChangesFn.mockResolvedValue({ items: [], unattributed: 1 });
		await render();
		assertGraphLoaded();

		const panel = host.querySelector('.changes');
		expect(panel, 'every row was hidden and the whole panel disappeared with them').not.toBeNull();
		expect(panel!.textContent).toContain('ontology_recent_changes');
		expect(panel!.querySelector('[data-testid="changes-unattributed"]')!.textContent).toContain(
			'ontology_recent_changes_unattributed:1'
		);
		expect(panel!.querySelectorAll('li')).toHaveLength(0);
	});

	it('nothing hidden → no disclosure line (the complement, so "always show it" cannot pass)', async () => {
		recentChangesFn.mockResolvedValue({ items: [change('a1', 'Mary de Vries')], unattributed: 0 });
		await render();
		assertGraphLoaded();
		expect(host.querySelector('.changes li')).not.toBeNull();
		expect(host.querySelector('[data-testid="changes-unattributed"]')).toBeNull();
		expect(host.textContent).not.toContain('ontology_recent_changes_unattributed');
	});

	it('a 403 still says nothing at all — the disclosure did not resurrect the panel', async () => {
		// The scoping fix must not have widened the panel's audience by accident: for the members
		// /ontology is nav-open to, this route 403s and silence remains the honest rendering. The
		// full three-way discrimination lives in the sibling failure spec; this pins that the
		// `|| changesUnattributed > 0` branch added above cannot open the panel on an error path.
		recentChangesFn.mockRejectedValue(new FakeApiError(403, 'forbidden'));
		await render();
		assertGraphLoaded();
		expect(host.querySelector('.changes')).toBeNull();
		expect(host.querySelector('[data-testid="changes-unattributed"]')).toBeNull();
	});
});
