// @vitest-environment jsdom
//
// src/routes/ontology/ontology-page.system-actor.render.test.ts — the actor span of one line in
// /ontology's "Recente wijzigingen" panel.
//
// ⛔ THE DEFECT, AND WHY THIS PANEL IS THE WORST PLACE FOR IT. Every other span on the line is
// already localized — `ontologyActionLabel(c.action)` turns the backend enum into words,
// `timeAgo(c.createdAt)` turns the stamp into "2u geleden" — and the actor was the one field the
// SERVER wrote for the reader: `backend/src/ontology/ontology-changes.ts` answered an
// `actor_id IS NULL` row with the literal `{ name: 'System', initials: 'SYS' }`. A Dutch reader got
//
//     System · Aangepaste entiteit aangemaakt · 2u geleden
//
// one English noun wedged into an otherwise Dutch sentence, in the slot the eye scans for a NAME.
//
// The wire now carries the FACT (`actor: null` — no human wrote this row) and the browser owns the
// word. `backend/tests/ontology-changes-tenant-scope.test.ts` drives the server half against real
// Postgres; a mocked client here could only ever return what this file told it to.
//
// ⚠️ NON-VACUITY IS DOUBLE-GATED. The panel lives inside `{#if ontology}`, so a page stuck in its
// loading branch renders no panel at all and every "the English is absent" assertion passes for
// free — the sibling spec's `assertGraphLoaded()` gate is reproduced here for that reason. On top
// of it, every case renders a HUMAN-authored row beside the unattributed one and asserts the human
// name still arrives verbatim, so "it localized the absence" cannot be confused with "it stopped
// rendering actors".
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { AuditItem } from '$lib/types/audit';
import type { CompiledOntology, MatrixData } from '$lib/types/ontology';

// The real `en` catalog, every key resolving to its own name — so a key this page asks for and the
// catalog does not have reds here instead of rendering an empty span. `audit_actor_system` is the
// subject, and its token ('audit_actor_system') shares no substring with the capital-S English
// literal being banished, so `not.toContain('System')` cannot be satisfied by the replacement.
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

function change(id: string, actor: AuditItem['actor']): AuditItem {
	return {
		id,
		action: 'ontology.entity_create',
		category: 'data',
		targetType: 'ontology_entity',
		targetId: '3f1c0000-0000-4000-8000-00000000a8b2',
		result: 'ok',
		resultTone: 'ok',
		createdAt: '2026-08-14T09:00:00.000Z',
		actor
	};
}

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 16; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

async function render(items: AuditItem[]) {
	matrixFn.mockResolvedValue(matrix());
	getOntology.mockResolvedValue(ontology());
	recentChangesFn.mockResolvedValue({ items, unattributed: 0 });
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
}

/** The panel lives inside `{#if ontology}` — a page stuck loading renders nothing and passes every
 *  absence check for free. Same gate as the sibling tenant-scope spec. */
function assertPanelRendered() {
	expect(recentChangesFn, 'the changes feed was never requested').toHaveBeenCalled();
	expect(
		host.querySelector('.graph-col'),
		'the ontology page never left its loading branch'
	).not.toBeNull();
	expect(host.querySelectorAll('.ch-actor').length, 'no change line rendered at all').toBeGreaterThan(
		0
	);
}

const actorTexts = () => [...host.querySelectorAll('.ch-actor')].map((e) => e.textContent);

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

describe('/ontology "Recent changes" names an unattributed row in the reader’s language', () => {
	it('⛔ `actor: null` renders the catalog word, and a human name beside it is untouched', async () => {
		await render([
			change('a1', null),
			change('a2', { name: 'Mary de Vries', initials: 'MV' })
		]);
		assertPanelRendered();
		expect(actorTexts()).toEqual(['audit_actor_system', 'Mary de Vries']);
	});

	it('⛔ the English literal "System" is nowhere in the panel', async () => {
		// The whole-panel assertion, not just the one span: a fix that localized the span and left a
		// hardcoded fallback in a sibling branch (a tooltip, an aria-label) would pass the case above.
		await render([change('a1', null)]);
		assertPanelRendered();
		expect(host.querySelector('.changes-card, .graph-col')!.textContent).not.toContain('System');
	});

	it('⚠️ MID-ROLL — an old pod still sending `{ name: "System" }` renders it, unchanged', async () => {
		// The browser cannot distinguish that object from a user genuinely named "System", and must
		// not try — sniffing the name would rename a real person. For the length of a rolling deploy
		// those rows read English, which is exactly today's behaviour, and they flip as soon as the
		// pod behind the Service is the new one.
		await render([change('a1', { name: 'System', initials: 'SYS' })]);
		assertPanelRendered();
		expect(actorTexts()).toEqual(['System']);
	});
});
