// @vitest-environment jsdom
//
// src/routes/block-edit/block-edit.locale-refetch.render.test.ts — the block EDITOR must follow the
// reader's language too, and it must do it without eating an unsaved draft.
//
// ⛔ THE DEFECT. `GET /api/blocks/:slug` localizes `name`, `description` and the current version's
// `docs_md` server-side (backend/src/routes/blocks.ts:441-550) off `Accept-Language`. The page
// fetched once, from an `$effect` that tracks `slug` and nothing else, and carried no
// `reloadOnLocaleChange` — so a language switch relocalized every `m.*()` label on the screen and
// left the block's own NAME (the `<h1>`) and its documentation in the language it was first opened
// in.
//
// ⛔ AND THE FIX THAT WOULD HAVE BEEN WORSE THAN THE DEFECT — which is what the second case is for.
// The obvious idiom, `reloadOnLocaleChange(() => loadDetail(slug))`, is a DATA-LOSS BUG here.
// `loadDetail` ends in `selectVersion()`, and `selectVersion` overwrites EVERY editor buffer:
// `docsMd`, `sourceTs`, `caps`, `inputs`, `outputs`, `examplesText` — plus `findings`,
// `lintFindings` and `lintState`. An author half-way through a draft who reaches for the language
// switcher would have had their unsaved work silently replaced by the server's copy. There is no
// undo on this screen and no autosave; the draft is simply gone. `/blocks` can afford a blind
// refetch (it holds no user input); this page cannot, so it re-applies only the DISPLAY metadata.
//
// ⛔ THE ANTI-VACUITY RULE. Case 1 asserts the Dutch name is present AND the English name is gone
// AND the header still exists; case 2 asserts the author's own text is STILL THERE (a page that
// crashed would satisfy "the server's Dutch docs are absent" trivially); case 3 proves the
// read-only branch is live, so case 2's guard cannot be passing merely because nothing ever
// relocalizes docs at all. The English and Dutch fixtures share no substring, checked rather than
// assumed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { BlockDetail, BlockVersion } from '$lib/types/blocks';
import { locale } from '$lib/stores/locale.svelte';

// Real `en` catalog, each key resolving to its own name — the chrome is not the subject here.
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

const SLUG = 'invoice-parser';

// ⚠️ THE SLUG IS SPELLED OUT, NOT INTERPOLATED FROM `SLUG`. `vi.mock` factories are hoisted above
// every `const` in the file, so referencing one throws `Cannot access 'SLUG' before initialization`
// at import time — which surfaces as "there was an error when mocking a module" and collects ZERO
// tests, i.e. a green-looking file that ran nothing.
vi.mock('$app/state', () => ({
	page: { url: new URL('http://localhost/block-edit?slug=invoice-parser'), params: {} }
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

const { getBlock, lint } = vi.hoisted(() => ({ getBlock: vi.fn(), lint: vi.fn() }));
// ⛔ ALIAS module ids, never relative ones. `ApiError` must be a real class — the page branches on
// `e instanceof ApiError` in several catches; a plain object silently reroutes them.
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
		saveVersion: vi.fn(),
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
// A developer of the owning tenant — `canAuthor`, so the draft's editors are live and `editable`
// is true. That is the state the data-loss case needs.
vi.mock('$lib/stores/auth.svelte', () => ({
	auth: { isDeveloper: true, isSuperAdmin: false, isTenantAdmin: false, user: { roles: ['developer'] } }
}));

import Page from './+page.svelte';

/** ⛔ No substring overlap in either direction — pinned by the first case, not trusted. */
const EN = { name: 'Invoice parser', docs: '# Invoice parser\n\nReads a supplier document.' };
const NL = { name: 'Factuurverwerker', docs: '# Factuurverwerker\n\nLeest een leveranciersbestand.' };

/** What the author typed and has NOT saved. Shares nothing with either server fixture. */
const UNSAVED = '# MIJN EIGEN AANTEKENINGEN, nog niet opgeslagen';

function version(over: { docs: string; status: BlockVersion['status'] }): BlockVersion {
	return {
		id: 'v1',
		block_id: 'b1',
		version: '3',
		status: over.status,
		language: 'typescript',
		docs_md: over.docs,
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

function detail(over: {
	name: string;
	docs: string;
	status: BlockVersion['status'];
}): BlockDetail {
	const v = version({ docs: over.docs, status: over.status });
	return {
		id: 'b1',
		slug: SLUG,
		name: over.name,
		description: over.name,
		category: 'data',
		// A published version is the block's CURRENT one — which is also the only version the
		// backend overlays a translated `docs_md` onto (routes/blocks.ts:460).
		current_version_id: over.status === 'draft' ? null : 'v1',
		maintainer_id: null,
		owner: 'tenant',
		region: null,
		cost_class: null,
		license: null,
		archived: false,
		created_at: '2026-08-01T00:00:00.000Z',
		updated_at: '2026-08-01T00:00:00.000Z',
		maintainer: null,
		versions: [v]
	} as BlockDetail;
}

let target: HTMLElement;
let component: Record<string, unknown> | null = null;
const initialLocale = locale.current;

async function settle() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

function headName(): string {
	return target.querySelector('header.edit-head h1')?.textContent ?? '';
}
/** The docs buffer, whichever face it is wearing: a live textarea, or the read-only `<pre>`. */
function docsField(): HTMLTextAreaElement | null {
	return target.querySelector('textarea.md-source');
}
function docsText(): string {
	const ta = docsField();
	if (ta) return ta.value;
	return target.querySelector('pre.md-source')?.textContent ?? '';
}

/**
 * ⚠️ ASSIGNED DIRECTLY, NEVER VIA `locale.set()`: that method fires an unmocked `authFetch` PATCH
 * to `/api/me/locale`. The rune assignment IS the trigger — `reloadOnLocaleChange` tracks
 * `locale.current` and nothing else.
 */
async function switchToDutch() {
	locale.current = 'nl';
	flushSync();
	await settle();
}

async function render(status: BlockVersion['status']) {
	getBlock.mockResolvedValue(detail({ name: EN.name, docs: EN.docs, status }));
	lint.mockResolvedValue({ ok: true, findings: [] });
	component = mount(Page, { target }) as Record<string, unknown>;
	await settle();
	// ⛔ THE POSITIVE MARKER — /block-edit mounts a dozen components; one that throws and every
	// "the English is absent" assertion below passes against an empty DOM.
	expect(
		target.querySelector('header.edit-head'),
		'the editor never rendered, so this file tests nothing'
	).not.toBeNull();
	expect(headName(), 'the English block name never reached the header').toContain(EN.name);
}

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
});
afterEach(() => {
	if (component) unmount(component);
	component = null;
	target.remove();
	locale.current = initialLocale;
	flushSync();
	getBlock.mockReset();
	lint.mockReset();
});

describe('/block-edit follows the reader’s language without eating the draft', () => {
	it('the two fixtures really are different, and neither contains the other', () => {
		for (const [a, b] of [
			[EN.name, NL.name],
			[NL.name, EN.name],
			[EN.docs, NL.docs],
			[NL.docs, EN.docs],
			[UNSAVED, NL.docs],
			[NL.docs, UNSAVED]
		]) {
			expect(a!.includes(b!), `"${a}" must not contain "${b}"`).toBe(false);
		}
	});

	it('⛔ a locale switch re-requests the block and the header is Dutch, with no English left', async () => {
		await render('draft');
		expect(headName()).not.toContain(NL.name);

		getBlock.mockResolvedValue(detail({ name: NL.name, docs: NL.docs, status: 'draft' }));
		await switchToDutch();

		expect(getBlock, 'the locale switch did not refetch the block').toHaveBeenCalledTimes(2);
		// The header still exists — not a blank page, not the load-error branch.
		expect(target.querySelector('header.edit-head')).not.toBeNull();
		expect(headName()).toContain(NL.name);
		expect(headName()).not.toContain(EN.name);
	});

	it('⛔ …and an UNSAVED draft in the docs editor survives the switch untouched', async () => {
		await render('draft');
		const ta = docsField();
		expect(ta, 'the docs editor is not editable, so this case cannot test what it claims').not.toBeNull();

		// The author types. `bubbles: true` — Svelte 5 delegates DOM events to the mount root, so a
		// non-bubbling synthetic event would never reach `bind:value` and the buffer would still hold
		// the server's text, making the assertion below pass for the wrong reason.
		ta!.value = UNSAVED;
		ta!.dispatchEvent(new Event('input', { bubbles: true }));
		await settle();
		expect(docsText(), 'the typed text never reached the buffer').toBe(UNSAVED);

		getBlock.mockResolvedValue(detail({ name: NL.name, docs: NL.docs, status: 'draft' }));
		await switchToDutch();

		// The relocalization happened…
		expect(headName()).toContain(NL.name);
		// …and it did NOT reach into the editor. Red against
		// `reloadOnLocaleChange(() => loadDetail(slug))`, which routes through `selectVersion()`.
		expect(docsText(), 'the locale switch destroyed the author’s unsaved draft').toBe(UNSAVED);
		expect(docsText()).not.toContain(NL.docs);
	});

	it('a READ-ONLY (published) version does relocalize its docs — the guard is a guard, not a hole', async () => {
		// Without this case, case 2 would also pass against an implementation that never relocalizes
		// docs under any circumstances, and the `editable` distinction would be untested.
		await render('stable');
		expect(docsField(), 'a published version must render the docs read-only').toBeNull();
		expect(docsText()).toContain(EN.docs);

		getBlock.mockResolvedValue(detail({ name: NL.name, docs: NL.docs, status: 'stable' }));
		await switchToDutch();

		expect(headName()).toContain(NL.name);
		expect(docsText()).toContain(NL.docs);
		expect(docsText()).not.toContain(EN.docs);
	});
});
