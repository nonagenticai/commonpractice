// @vitest-environment jsdom
//
// src/routes/block-edit/block-edit.publish-after-failed-save.render.test.ts — Publish must not tell
// the author their UNSAVED work shipped.
//
// ⛔ THE DEFECT. `publish()` opened with `await saveDraft(); // persist edits first` and then
// carried on no matter what came back. `saveDraft` returned `void` and reported failure ONLY by
// writing `banner` — and `publish()`'s own success path OVERWRITES `banner`. So the sequence a
// 409 (or a 422, or a dropped connection) produced was:
//
//     save 409s          → banner = red "could not save"        (on screen for one tick)
//     publish proceeds   → the server publishes the LAST PERSISTED source, and 201s
//     publish succeeds   → banner = green "v3 published"
//
// The author is looking at their edits, is told the version is live, and what shipped is the code
// from before those edits. There is nothing left on screen to suggest otherwise. `saveDraft` now
// returns whether the write landed and `publish()` returns early when it did not.
//
// ⛔ THE ASSERTION THAT MATTERS IS THE ONE ABOUT THE NETWORK, not about the banner: a banner fix
// alone (say "publish failed" after publishing) would still have published. So every failure case
// asserts `blocksApi.publish` was NEVER CALLED — and the healthy case asserts it WAS, so "never
// publish anything" cannot pass this file.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { BlockDetail, BlockVersion } from '$lib/types/blocks';

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

vi.mock('$app/state', () => ({
	page: { url: new URL('http://localhost/block-edit?slug=claims-triage'), params: {} }
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

const { getBlock, saveVersion, publishVersion, lint } = vi.hoisted(() => ({
	getBlock: vi.fn(),
	saveVersion: vi.fn(),
	publishVersion: vi.fn(),
	lint: vi.fn()
}));
// ⛔ `ApiError` MUST BE A REAL CLASS with `status` / `code`: `publish()` branches on
// `e instanceof ApiError && e.code === 'lint_failed'` and friends, and `saveDraft` is where a 409
// arrives. A plain object would fall through to the generic branch and quietly change the subject.
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
		saveVersion,
		publish: publishVersion,
		lint,
		createVersion: vi.fn(),
		create: vi.fn(),
		remove: vi.fn()
	}
}));
vi.mock('$lib/api/templates', () => ({ templatesApi: { create: vi.fn(), list: vi.fn() } }));
vi.mock('$lib/api/ontology', () => ({
	ApiError: class ApiError extends Error {},
	ontologyApi: { matrix: vi.fn().mockResolvedValue({ industries: [], departments: [], cells: [] }), get: vi.fn() }
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));
vi.mock('$lib/stores/auth.svelte', () => ({
	auth: { isDeveloper: true, isSuperAdmin: true, isTenantAdmin: true }
}));

import { ApiError } from '$lib/api/blocks';
import Page from './+page.svelte';

const SLUG = 'claims-triage';

function version(): BlockVersion {
	return {
		id: 'v-draft-1',
		block_id: 'b1',
		version: '3',
		status: 'draft',
		language: 'typescript',
		docs_md: '# Claims triage',
		source_ts: 'export default function () {}',
		// ⚠️ TYPED WITHOUT A CAST — `inputs`/`outputs` are `Record<string, FieldSpec>`, not arrays, and
		// the compiler is the cheapest reviewer of a fixture.
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

function detail(): BlockDetail {
	return {
		id: 'b1',
		slug: SLUG,
		name: 'Claims triage',
		description: 'Triage a claim',
		category: 'logic',
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

async function settle() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

async function mountPage() {
	getBlock.mockResolvedValue(detail());
	lint.mockResolvedValue({ findings: [] });
	component = mount(Page, { target }) as Record<string, unknown>;
	await settle();
}

/**
 * ⛔ THE ANTI-VACUITY GATE. The Publish button lives behind a loaded `detail` AND a selected DRAFT
 * version (`disabled={!isDraft || saving}`). If the fixture had loaded as a published version, or
 * `blocksApi.get` had not resolved, the button would be absent or disabled, `publish()` would never
 * run, and "publish was not called" would pass without the fix existing.
 */
async function clickPublish() {
	const btn = [...target.querySelectorAll('button')].find(
		(b) => b.textContent?.trim() === 'blockedit_publish'
	);
	expect(btn, 'the Publish button never rendered — this case tests nothing').toBeDefined();
	expect(btn!.disabled, 'the Publish button is disabled, so the click proves nothing').toBe(false);
	// ⛔ `bubbles: true` — Svelte 5 delegates DOM events to the mount root.
	btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await settle();
}

function banner(): HTMLElement | null {
	return target.querySelector('.banner');
}

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
});
afterEach(() => {
	if (component) unmount(component);
	component = null;
	target.remove();
	for (const fn of [getBlock, saveVersion, publishVersion, lint]) fn.mockReset();
});

describe('/block-edit Publish reads the outcome of the save it performs first', () => {
	it('⛔ a 409 on saveVersion means publish is NEVER called', async () => {
		// REVERT THAT TURNS THIS RED: `await saveDraft();` without reading the result. `publish` then
		// runs against the last persisted source and this assertion inverts — measured, not assumed.
		saveVersion.mockRejectedValue(new ApiError(409, 'version_conflict', 'stale version'));
		publishVersion.mockResolvedValue({ version: '3' });
		await mountPage();
		await clickPublish();

		expect(saveVersion, 'the save never ran, so the case is vacuous').toHaveBeenCalledTimes(1);
		expect(
			publishVersion,
			'the editor published a version whose save had just failed — the defect verbatim'
		).not.toHaveBeenCalled();
	});

	it('⛔ …and the banner still shows the SAVE error, not a green "published"', async () => {
		// The other half of the lie: the failure banner survived for exactly one tick before the
		// success path wrote over it. Both facts are asserted, not just the network one.
		saveVersion.mockRejectedValue(new ApiError(409, 'version_conflict', 'stale version'));
		publishVersion.mockResolvedValue({ version: '3' });
		await mountPage();
		await clickPublish();

		const b = banner();
		expect(b, 'no banner at all — the reader was told nothing').not.toBeNull();
		expect(b!.className, 'the banner is the green one').toContain('error');
		expect(b!.textContent).toContain('error_save_failed');
		expect(b!.textContent, 'the reader was told a version shipped').not.toContain(
			'blockedit_published'
		);
	});

	it('⛔ a malformed Examples JSON blocks the publish too', async () => {
		// `saveDraft`'s OTHER failure exit: `parseExamples()` returns null and it bails BEFORE any
		// request. That path never even reached the network, so `publish` shipped the stored source
		// while the author looked at an examples array the server had never seen.
		await mountPage();
		const examplesTab = [...target.querySelectorAll('button')].find(
			(b) => b.textContent?.trim() === 'blockedit_tab_examples'
		);
		expect(examplesTab, 'the Examples tab is missing').toBeDefined();
		examplesTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle();
		const area = target.querySelector('textarea');
		expect(area, 'the examples editor did not render').not.toBeNull();
		area!.value = '{ not json';
		area!.dispatchEvent(new Event('input', { bubbles: true }));
		await settle();

		publishVersion.mockResolvedValue({ version: '3' });
		await clickPublish();

		expect(saveVersion, 'a bail before the request must not hit the network').not.toHaveBeenCalled();
		expect(publishVersion, 'the editor published past a JSON bail').not.toHaveBeenCalled();
		expect(banner()?.textContent).toContain('blockedit_err_examples_json');
	});

	it('a successful save DOES publish — and the version is re-read from the server', async () => {
		// ⛔ THE COMPLEMENT AND THE OVER-CORRECTION GUARD. "Never publish" satisfies every assertion
		// above; this is the case that stops it. It also pins the ORDER: the save is the first call.
		saveVersion.mockResolvedValue({ ...version(), id: 'v-draft-1' });
		publishVersion.mockResolvedValue({ version: '3' });
		await mountPage();
		expect(getBlock).toHaveBeenCalledTimes(1);
		await clickPublish();

		expect(saveVersion).toHaveBeenCalledTimes(1);
		expect(publishVersion, 'a healthy save no longer publishes').toHaveBeenCalledTimes(1);
		expect(publishVersion.mock.calls[0]).toEqual([SLUG, '3', 'stable']);
		// The publish path ends in `loadDetail()`, which is the observable proof it ran to completion.
		expect(getBlock, 'publish did not reload the block').toHaveBeenCalledTimes(2);

		// ⛔ AND THE AUTHOR IS TOLD. This line used to read `expect(banner()).toBeNull()`, pinning the
		// defect that `publish()` wrote its green line and THEN awaited `loadDetail()`, whose
		// `selectVersion()` ends in `banner = null` — so a successful publish erased its own only
		// confirmation and the screen shouted on every failure and said nothing on success. Its
		// comment said "the day someone fixes it, this line reds and they are told where the
		// expectation lived". This is that day; the fix is the `newDraft()` ordering (reload, THEN
		// banner) and the assertion is inverted rather than deleted.
		const b = banner();
		expect(b, 'a successful publish told the author nothing').not.toBeNull();
		expect(b!.className).toContain('ok');
		expect(b!.textContent).toContain('blockedit_published:3');
		// ⛔ THE ANTI-CHEAT. The banner also survives if the reload is simply deleted — which would
		// leave the author looking at a stale version list with a green line over it. The reload is
		// re-asserted HERE, inside the case that reads the banner, so the two cannot be traded.
		expect(getBlock, 'the banner survived because the reload never ran').toHaveBeenCalledTimes(2);
		expect(target.textContent).not.toContain('error_save_failed');
	});

	it('⛔ …and clicking a DIFFERENT version clears it — the fix is at the call site, not in selectVersion', async () => {
		// ⛔ THE OVER-CORRECTION GUARD. The obvious "fix" for the case above is to delete
		// `banner = null` from `selectVersion()`. That line is CORRECT: it is what stops a green
		// "v3 published" hanging over v4 when the reader clicks another entry in the version history.
		// REVERT THAT TURNS THIS RED: remove `banner = null` from `selectVersion()` — the green line
		// then survives the click and captions the wrong version.
		//
		// The fixture needs TWO versions for a second `button.ver` to exist at all, and the reload
		// must return both so the sidebar still has them after the publish.
		// ⚠️ `stable`, not `published`: `status` is the `block_versions.status` enum
		// (draft/stable/beta/deprecated) and the header renders `STATUS_LABEL_KEYS[status]` — an
		// invented value indexes the message module with `undefined` and the mock throws.
		const published: BlockVersion = {
			...version(),
			id: 'v-pub-2',
			version: '2',
			status: 'stable',
			published_at: '2026-08-02T00:00:00.000Z'
		};
		const twoVersions = (): BlockDetail =>
			({ ...detail(), current_version_id: 'v-pub-2', versions: [version(), published] }) as BlockDetail;
		getBlock.mockResolvedValue(twoVersions());
		lint.mockResolvedValue({ findings: [] });
		saveVersion.mockResolvedValue({ ...version() });
		publishVersion.mockResolvedValue({ version: '3' });
		component = mount(Page, { target }) as Record<string, unknown>;
		await settle();
		await clickPublish();
		expect(banner(), 'the publish banner never appeared, so clearing it proves nothing').not.toBeNull();

		// The sidebar entry for the OTHER version — the draft is the one auto-selected by `loadDetail`.
		const other = [...target.querySelectorAll('button.ver')].find((b) => !b.classList.contains('sel'));
		expect(other, 'the version history rendered fewer than two entries — this case is vacuous').toBeDefined();
		other!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle();

		expect(
			banner(),
			'“v3 published” is still on screen over a version that was not published'
		).toBeNull();
	});
});
