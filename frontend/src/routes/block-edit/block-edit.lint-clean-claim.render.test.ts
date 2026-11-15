// @vitest-environment jsdom
//
// src/routes/block-edit/block-edit.lint-clean-claim.render.test.ts — "type-check clean" said on a
// type-check that never happened.
//
// ⛔ THE DEFECT. `runLint()` writes `lintFindings` on success and has an EMPTY `catch {}`; the badge
// under the Implementation editor renders the teal `blockedit_lint_clean` on nothing more than
// `lintFindings.length === 0`. Three reachable states therefore render a green claim about a buffer
// nothing ever checked:
//   (a) the POST fails — `backend/src/blocks/lint.ts` shells out to the real `tsc`, so a 5xx or a
//       dropped connection is an ordinary outcome, and the catch swallowed it;
//   (b) a READER — the debounce `$effect` is gated on `editable`, so on a PUBLISHED version (and for
//       anyone who cannot author the block) the lint NEVER RUNS and the badge is teal from the first
//       paint to the last;
//   (c) the 700 ms debounce window — every re-arm of the timer leaves the PREVIOUS answer on screen
//       describing a buffer that has since changed.
//
// ⚠️ IT IS A FALSE ASSURANCE, NOT A SECURITY HOLE, and this file is written to that scope. Publish
// re-lints server-side (`backend/src/routes/blocks.ts:599`) and refuses `lint_failed`, so nothing
// unsafe ships past a green badge — what ships is an author's belief that the editor checked their
// code. The fix is a `lintState` the badge reads, not a new gate.
//
// ⛔ THE FAILURE IS DRIVEN THROUGH THE REAL CLIENT, NOT A HAND-BUILT REJECTION. `$lib/api/blocks` is
// NOT mocked here: only `$lib/api/auth-fetch` is, and it answers with real `Response` objects, so
// case (a) travels through `blocksApi.lint`'s own `unwrap` exactly as a browser's would. A test that
// builds the error object itself cannot discover that the product's error path differs — the lesson
// of `src/lib/api/error-message.wire.test.ts`.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { BlockDetail, BlockVersion, LintFinding } from '$lib/types/blocks';

// Real `en` catalog, each key resolving to its own name — assertions name a KEY, never copy.
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

const { nav, store, authFetch } = vi.hoisted(() => ({
	nav: { url: new URL('http://localhost/block-edit?slug=claims-triage') },
	store: {
		auth: {
			user: { roles: ['developer'] } as { roles: string[] } | null,
			isDeveloper: true,
			isTenantAdmin: false,
			isSuperAdmin: false
		}
	},
	// ⛔ The ALIAS id. A relative specifier silently fails to apply and the real browser-only
	// keycloak chain loads instead (see llm-settings.test.ts's header).
	authFetch: vi.fn()
}));
vi.mock('$lib/api/auth-fetch', () => ({ authFetch }));
vi.mock('$app/state', () => ({
	page: {
		get url() {
			return nav.url;
		},
		params: {}
	}
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/stores/auth.svelte', () => ({ auth: store.auth }));

import * as m from '$lib/paraglide/messages';
import Page from './+page.svelte';

const SLUG = 'claims-triage';

// ── the wire ────────────────────────────────────────────────────────────────────────────────────
/** Every request the mounted page issues, as `METHOD /path`. */
let wire: string[] = [];
/** What `POST …/lint` answers. Swapped per case; a 500 is what a crashed `tsc` really produces. */
let lintReply: { status: number; body: unknown } = { status: 200, body: { ok: true, findings: [] } };

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});

function version(over: Partial<BlockVersion> = {}): BlockVersion {
	return {
		id: 'v-draft-3',
		block_id: 'b1',
		version: '3',
		status: 'draft',
		language: 'typescript',
		docs_md: '# Claims triage',
		source_ts: 'export default function () { return {}; }',
		descriptor: { inputs: {}, outputs: {}, capabilities: { network: false } },
		examples: [],
		changelog: '',
		tests_passing: false,
		usage_count: 0,
		published_by: null,
		published_at: null,
		created_at: '2026-08-01T00:00:00.000Z',
		author: null,
		...over
	} as BlockVersion;
}

/** A draft (v3, editable) plus the published v2 the history sidebar can switch to. */
const PUBLISHED = version({
	id: 'v-pub-2',
	version: '2',
	status: 'stable',
	source_ts: 'export default function () { return { old: true }; }',
	published_at: '2026-07-01T00:00:00.000Z',
	tests_passing: true
});

function detail(over: Partial<BlockDetail> = {}): BlockDetail {
	return {
		id: 'b1',
		slug: SLUG,
		name: 'Claims triage',
		description: 'Triage a claim',
		category: 'logic',
		current_version_id: 'v-pub-2',
		maintainer_id: null,
		owner: 'tenant',
		region: null,
		cost_class: null,
		license: null,
		archived: false,
		created_at: '2026-08-01T00:00:00.000Z',
		updated_at: '2026-08-01T00:00:00.000Z',
		maintainer: null,
		versions: [version(), PUBLISHED],
		...over
	} as BlockDetail;
}

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
	wire = [];
	lintReply = { status: 200, body: { ok: true, findings: [] } };
	Object.assign(store.auth, {
		user: { roles: ['developer'] },
		isDeveloper: true,
		isTenantAdmin: false,
		isSuperAdmin: false
	});
	authFetch.mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const url = typeof input === 'string' ? input : String(input);
		const method = (init.method ?? 'GET').toUpperCase();
		wire.push(`${method} ${url}`);
		if (method === 'POST' && url.endsWith('/lint')) return json(lintReply.body, lintReply.status);
		if (method === 'GET' && url === `/api/blocks/${SLUG}`) return json(detail());
		if (url.includes('/tests')) return json({ items: [], total: 0, version_id: 'v-draft-3' });
		// Everything else this screen touches on mount (templates, ontology matrix, …) — quiet, 200.
		return json({ items: [], total: 0, industries: [], departments: [], cells: [] });
	});
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	authFetch.mockReset();
});

async function settle() {
	for (let i = 0; i < 24; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}
/** The live lint is debounced by 700 ms in a `$effect`. Real time, once — fake timers here would
 *  also freeze Svelte's own scheduling. */
async function pastDebounce() {
	await new Promise((r) => setTimeout(r, 900));
	await settle();
}

const buttonLabelled = (label: string) =>
	[...host.querySelectorAll<HTMLButtonElement>('button')].find(
		(b) => b.textContent?.trim() === label
	);
const click = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));

/** The whole badge strip beside "N lines" — the subject of this file. */
const badges = () => host.querySelector('.impl-badges')?.textContent?.trim() ?? '';

/** Mount, wait for the detail load, and open the Implementation tab. */
async function open() {
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
	// ⛔ POSITIVE ANCHOR. A page still on its skeleton answers every "…does not say clean" for free.
	expect(host.querySelector('h1')?.textContent, 'the block never loaded').toBe('Claims triage');
	const tab = buttonLabelled(m.blockedit_tab_implementation());
	expect(tab, 'the Implementation tab never rendered — the badge is unreachable').toBeDefined();
	click(tab!);
	await settle();
	expect(host.querySelector('.impl-badges'), 'the badge strip never rendered').not.toBeNull();
}

describe('/block-edit never claims a type-check it did not run', () => {
	it('⛔ (a) the lint POST 500s — the badge must not answer teal "clean"', async () => {
		lintReply = { status: 500, body: { error: 'internal_error', message: 'tsc exited 2' } };
		await open();
		await pastDebounce();
		// Non-vacuity: the request really went out and really failed.
		expect(
			wire.filter((c) => c.startsWith('POST') && c.endsWith('/lint')),
			'the debounced lint never fired, so this case tests nothing'
		).toHaveLength(1);
		expect(badges(), 'a failed type-check still renders "type-check clean"').not.toContain(
			m.blockedit_lint_clean()
		);
		// The author CAN act on this one (they own the draft): say the check did not happen.
		expect(badges()).toContain(m.blockedit_lint_failed());
	});

	it('⛔ (b) a PUBLISHED version is never linted — the badge is idle, not clean, and not an error',
		async () => {
			// `editable = canAuthor && (!slug || isDraft)`, and the debounce `$effect` is gated on it.
			// Switching the history sidebar to the published v2 replaces the buffer with source this
			// screen will never check — `POST …/lint` there is `authorizeBlockWrite`.
			await open();
			await pastDebounce();
			expect(badges(), 'the draft never linted clean, so the switch below proves nothing').toContain(
				m.blockedit_lint_clean()
			);
			const before = wire.length;

			const rows = [...host.querySelectorAll<HTMLButtonElement>('button.ver')];
			expect(rows.length, 'the version history never rendered').toBe(2);
			const pub = rows.find((r) => !r.classList.contains('sel'));
			expect(pub, 'both history rows are the selected one').toBeDefined();
			click(pub!);
			await settle();
			await pastDebounce();

			expect(
				wire.slice(before).filter((c) => c.endsWith('/lint')),
				'the page linted a version the API would refuse to lint'
			).toHaveLength(0);
			expect(
				badges(),
				'an un-linted published version renders "type-check clean"'
			).not.toContain(m.blockedit_lint_clean());
			// ⛔ AND NOT AN ERROR EITHER: nothing failed and the reader could not act on it if it had.
			expect(badges(), 'a reader is shown a failure they cannot act on').not.toContain(
				m.blockedit_lint_failed()
			);
			expect(badges()).toContain(m.blockedit_lint_unknown());
		});

	it('⛔ (c) during the 700 ms debounce the badge describes a buffer nothing has checked yet',
		async () => {
			await open();
			await pastDebounce();
			expect(badges(), 'the first lint never went green, so the window below is unreachable')
				.toContain(m.blockedit_lint_clean());

			// Re-arm the timer the way the editor does on every keystroke — the `$effect` re-runs on
			// `sourceTs`/`activeTab`, and leaving and re-entering the tab is the click-only way in.
			click(buttonLabelled(m.blockedit_tab_documentation())!);
			await settle();
			click(buttonLabelled(m.blockedit_tab_implementation())!);
			await settle();
			// Deliberately INSIDE the 700 ms: `linting` is still false, so the "type-checking…" branch
			// is not showing and the badge is answering from `lintFindings` alone.
			expect(badges(), 'the "type-checking…" branch is up — the window under test was missed')
				.not.toContain(m.blockedit_lint_checking());
			expect(badges(), 'the badge claims clean while the check is still only scheduled')
				.not.toContain(m.blockedit_lint_clean());
			expect(badges()).toContain(m.blockedit_lint_unknown());

			// …and it goes green again once the check actually runs. Without this half, `{#if false}`
			// on the teal badge passes every case in this file.
			await pastDebounce();
			expect(badges(), 'the badge never recovers after a real clean lint').toContain(
				m.blockedit_lint_clean()
			);
		});

	it('THE ASSURANCE SURVIVES: a real clean lint is teal, a real finding is coral', async () => {
		// ⛔ The over-correction guard. Deleting the teal badge passes every case above forever.
		await open();
		await pastDebounce();
		expect(badges()).toContain(m.blockedit_lint_clean());
		expect(badges()).not.toContain(m.blockedit_lint_unknown());
		expect(host.querySelector('.impl-badges .badge.teal')).not.toBeNull();

		unmount(app!);
		app = null;
		host.textContent = '';
		wire = [];
		const findings: LintFinding[] = [
			{ source: 'type', rule: 'TS2322', message: 'Type error', line: 5, col: 11 }
		];
		lintReply = { status: 200, body: { ok: false, findings } };
		await open();
		await pastDebounce();
		expect(badges(), 'a real finding no longer renders the issue count').toContain(
			m.blockedit_lint_issues({ count: 1 })
		);
		expect(badges()).not.toContain(m.blockedit_lint_clean());
	});
});
