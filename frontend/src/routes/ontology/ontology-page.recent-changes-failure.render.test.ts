// @vitest-environment jsdom
//
// src/routes/ontology/ontology-page.recent-changes-failure.render.test.ts — "Recent changes" must
// not vanish in a way that reads as "nothing has changed".
//
// ⛔ THE DEFECT. `loadChanges()` ended in `catch { recentChanges = []; }` and the panel is behind
// `{#if recentChanges.length > 0 || changesUnattributed > 0}`. So a 500 on the audit feed removed the whole block from the
// page, and on a screen whose entire subject is "what does this ontology look like and who has been
// editing it", an absent panel is read as an ANSWER: nobody has touched it in 30 days. The reader
// cannot tell a quiet month from a broken request.
//
// ⚠️ AND THE OBVIOUS FIX IS WRONG FOR MOST READERS. `GET /api/ontology/recent-changes` is
// `requireSuperAdmin` (its rows come from `audit_log`, the one table outside RLS by design — WS-4
// scoped the ANSWER to a workspace without widening who may read that table) while /ontology is
// nav-open to any member
// (lib/layout/navConfig.ts:122), so a 403 here is the EXPECTED answer for nearly everyone who opens
// this page. Reporting "recent changes could not be loaded" to them would turn the product working
// as designed into a red line on every visit — the noise that trains readers to ignore the real
// one. The route already models the discrimination in `routes/audit/+page.svelte`'s `denied` flag;
// this page copies it and stays SILENT on 401/403.
//
// So there are three renderings, and this file drives all three plus the healthy one:
//   500 / offline  → the panel, saying it could not be loaded
//   401 / 403      → nothing at all (the feed is not this reader's to read)
//   empty feed     → nothing at all (there is genuinely nothing to report)
//   rows           → the list
// (`unattributed > 0` is a fifth, and lives in `ontology-page.recent-changes-tenant-scope.render.test.ts`
// with the rest of the WS-4 scoping behaviour.)
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { AuditItem } from '$lib/types/audit';
import type { CompiledOntology, MatrixData } from '$lib/types/ontology';

// Real `en` catalog, each key resolving to its own name.
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

/**
 * ⛔ ONE `ApiError` CLASS — and this is the pivot of the whole file. The page tests
 * `e instanceof ApiError` against the class `$lib/api/ontology` re-exports from `./blocks`, so the
 * error the mocked `recentChanges` rejects with MUST be that same class. A second class here would
 * make that `instanceof` false, the 401/403 case would take the "real failure" branch, and this
 * file would report the silence guard as broken when it is not (or, worse, pass it for the wrong
 * reason).
 *
 * ⚠️ WS-4 MOVED THE CALL, NOT THE PROPERTY. The panel used to read `auditApi.list` — the PLATFORM
 * audit feed, which showed a super_admin every other workspace's ontology history. It now reads
 * `ontologyApi.recentChanges`, which resolves each row's owning tenant server-side. Every
 * rendering asserted below is unchanged by that move, which is the point: the scoping fix did not
 * get to quietly retire the silence guard.
 *
 * ⚠️ Declared inside `vi.hoisted` — `vi.mock` factories are hoisted above every top-level statement
 * in this file, so a plain `class` here is in the temporal dead zone when the factory runs and the
 * suite fails to COLLECT rather than to assert.
 */
const { matrixFn, getOntology, recentChangesFn, FakeApiError } = vi.hoisted(() => ({
	matrixFn: vi.fn(),
	getOntology: vi.fn(),
	recentChangesFn: vi.fn(),
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
		deleteSample: vi.fn(),
		recentChanges: recentChangesFn
	}
}));
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

/**
 * ⚠️ `entities: []` DELIBERATELY. The graph frame renders `OntologyGraph` (SvelteFlow) for a
 * non-empty ontology; the empty branch renders a notice instead. This file is about the panel BELOW
 * the graph, and the empty branch keeps the mount cheap without touching anything it asserts.
 */
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

/**
 * ⛔ THE ANTI-VACUITY GATE. The panel sits inside `{#if ontology}` inside `{:else if matrix}`. On a
 * page still in its loading branch there is no panel and no error line, and "no error is shown"
 * passes without the silence guard existing. So every case proves the graph column rendered first.
 */
function assertGraphLoaded() {
	expect(recentChangesFn, 'the changes feed was never requested').toHaveBeenCalled();
	expect(host.querySelector('.graph-col'), 'the ontology page never left its loading branch').not.toBeNull();
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
	for (const fn of [matrixFn, getOntology, recentChangesFn]) fn.mockReset();
});

describe('/ontology "Recent changes" is only asked for by a super_admin', () => {
	it.each([[['member']], [['developer']], [['tenant_admin']]])(
		'⛔ %j: the route is never called (it could only answer 403), and no panel renders',
		async (roles) => {
			// REVERT THAT TURNS THIS RED: drop the `auth.isSuperAdmin` guard in `loadChanges` — the
			// page asks again on every load and the member's console logs a 403 each time.
			auth.user = { roles } as never;
			recentChangesFn.mockRejectedValue(new FakeApiError(403, 'forbidden'));
			await render();
			expect(host.querySelector('.graph-col'), 'the ontology page never left its loading branch').not.toBeNull();
			expect(recentChangesFn).not.toHaveBeenCalled();
			expect(host.querySelector('.changes')).toBeNull();
		}
	);
});

describe('/ontology "Recent changes" tells a broken request from a quiet month', () => {
	it('⛔ a 500 renders the panel with a failure line — it does not disappear', async () => {
		// REVERT THAT TURNS THIS RED: `catch { recentChanges = []; }`. The panel is gone entirely and
		// both assertions below invert.
		recentChangesFn.mockRejectedValue(new Error('Failed to fetch'));
		await render();
		assertGraphLoaded();

		const panel = host.querySelector('.changes');
		expect(panel, 'the whole panel vanished — indistinguishable from "nothing changed"').not.toBeNull();
		// The heading is still there, so the reader knows WHICH panel failed…
		expect(panel!.textContent).toContain('ontology_recent_changes');
		// …and the failure is named.
		const err = panel!.querySelector('[data-testid="changes-error"]');
		expect(err, 'the panel rendered without saying anything').not.toBeNull();
		expect(err!.textContent).toContain('ontology_recent_changes_failed');
		expect(err!.getAttribute('role')).toBe('alert');
	});

	it('⛔ a 403 says NOTHING — the audit feed is not this member’s to read', async () => {
		// ⛔ THE CASE THAT STOPS THE NAIVE FIX. `GET /api/audit` is super-admin-only and /ontology is
		// open to every member, so this is the response MOST readers get. A page that shouted at them
		// would be a worse product than the one that stayed quiet, which is why the discrimination is
		// asserted as hard as the reporting.
		recentChangesFn.mockRejectedValue(new FakeApiError(403, 'forbidden'));
		await render();
		assertGraphLoaded();

		expect(host.querySelector('[data-testid="changes-error"]')).toBeNull();
		expect(host.textContent).not.toContain('ontology_recent_changes_failed');
		expect(host.querySelector('.changes'), 'a panel appeared for a reader with no access').toBeNull();
	});

	it('a 401 is treated the same way', async () => {
		recentChangesFn.mockRejectedValue(new FakeApiError(401, 'unauthorized'));
		await render();
		assertGraphLoaded();
		expect(host.querySelector('[data-testid="changes-error"]')).toBeNull();
		expect(host.querySelector('.changes')).toBeNull();
	});

	it('an EMPTY feed still renders nothing — a quiet month is not a failure', async () => {
		// ⛔ THE COMPLEMENT. A "fix" that always rendered the panel would put an empty box, or worse a
		// failure line, under every ontology nobody has edited.
		recentChangesFn.mockResolvedValue({ items: [], unattributed: 0 });
		await render();
		assertGraphLoaded();
		expect(host.querySelector('.changes')).toBeNull();
		expect(host.textContent).not.toContain('ontology_recent_changes_failed');
	});

	it('rows render as the list, with no failure line', async () => {
		// The healthy state, so "always show the error" cannot pass this file.
		recentChangesFn.mockResolvedValue({
			items: [change('a1', 'Mary de Vries'), change('a2', 'Sam Submitter')],
			unattributed: 0
		});
		await render();
		assertGraphLoaded();

		const panel = host.querySelector('.changes');
		expect(panel, 'the healthy panel did not render, so the contrast proves nothing').not.toBeNull();
		expect(panel!.querySelectorAll('li')).toHaveLength(2);
		expect(panel!.textContent).toContain('Mary de Vries');
		expect(panel!.querySelector('[data-testid="changes-error"]')).toBeNull();
	});
});
