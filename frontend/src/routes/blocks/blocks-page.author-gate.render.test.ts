// @vitest-environment jsdom
//
// src/routes/blocks/blocks-page.author-gate.render.test.ts — the library offered "New block" to
// readers the block API will not let author.
//
// ⛔ THE DEFECT. `/blocks` rendered `blocks_new_block` twice — in the page head and in the empty
// state — for everyone, and both buttons `goto('/block-edit')`. With no `?slug` that screen IS the
// create-new form, and `POST /api/blocks` is `requireBlockAuthor` (backend/src/routes/blocks.ts:561
// → `isDeveloper`). A member who took the offer got a form whose only button answers 403.
//
// ⛔ AND IT DEFEATED A GATE THE PRODUCT HAD ALREADY SET, DELIBERATELY. `navConfig.ts:130` carries
// `requiresRole: 'developer'` on `/block-edit`, with six lines of comment above it saying exactly
// this ("a member reaching it gets a form whose only button 403s, so the nav shouldn't offer it").
// The sidebar hid the screen; this page handed out a shortcut to it.
//
// ⛔ SO THE ASSERTION IS ABOUT THE NAV TABLE, NOT ABOUT A ROLE STRING. `canReachNav` is left REAL
// here (only the auth store is mocked), which is what makes the last case below meaningful: delete
// `requiresRole` from the nav item and the member half reds, because the two are now one fact.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { BlockListItem } from '$lib/types/blocks';

// Real `en` catalog, each key resolving to its own name — see the sibling render tests.
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

const { list, goto, store } = vi.hoisted(() => ({
	list: vi.fn(),
	goto: vi.fn(),
	// Mutable across cases: the page reads `auth.user?.roles` on every render.
	store: { auth: { user: null as { roles: string[] } | null } }
}));
// ⛔ ALIAS module ids, never relative ones.
vi.mock('$lib/api/blocks', () => ({ blocksApi: { list } }));
vi.mock('$app/navigation', () => ({ goto }));
vi.mock('$lib/api/error-message', () => ({ errorText: (_e: unknown, fallback: string) => fallback }));
vi.mock('$lib/stores/auth.svelte', () => ({ auth: store.auth }));

import Page from './+page.svelte';

const MEMBER = ['member'];
const DEVELOPER = ['developer'];

function block(slug: string): BlockListItem {
	return {
		slug,
		name: slug,
		description: 'foo bar',
		category: 'data',
		owner: 'platform' as BlockListItem['owner'],
		region: null,
		cost_class: null,
		version: '1.0.0',
		status: 'stable',
		usage_count: 3,
		maintainer: null,
		created_at: '2026-01-01T00:00:00.000Z'
	};
}

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

/** Mount the library for a role, with either a populated or an empty catalog. */
async function render(roles: string[], items: BlockListItem[]) {
	store.auth.user = { roles };
	window.history.replaceState({}, '', '/blocks');
	list.mockResolvedValue({ items, total: items.length });
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
	// ⛔ POSITIVE ANCHOR — a page still on its skeleton would answer every query below empty.
	expect(host.querySelector('h1')?.textContent, 'the library never rendered').toBe('blocks_title');
}

const newBlockButtons = () =>
	[...host.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'blocks_new_block');

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
	list.mockReset();
	goto.mockReset();
	store.auth.user = null;
});

describe('/blocks offers "New block" only to someone the block API would let create one', () => {
	it('⛔ THE DEFECT: a member is offered the create shortcut the nav table already refuses them', async () => {
		await render(MEMBER, [block('a-block')]);
		expect(
			newBlockButtons().length,
			'"New block" renders for a member — /block-edit then 403s on its only button'
		).toBe(0);
	});

	it('…and the EMPTY-library call to action is gated too, not just the header one', async () => {
		// Two call sites, one permission. Gating only the header leaves the empty state — the very
		// screen that pushes hardest towards creating something — handing out the same dead end.
		await render(MEMBER, []);
		expect(host.textContent, 'the empty state did not render, so this case proves nothing').toContain(
			'blocks_empty'
		);
		expect(newBlockButtons().length).toBe(0);
	});

	it('A DEVELOPER STILL GETS BOTH — the over-correction guard', async () => {
		// ⛔ `{#if false}` passes both cases above forever; this is the half that reds on it.
		await render(DEVELOPER, [block('a-block')]);
		expect(newBlockButtons().length, 'the author lost the create control').toBe(1);

		unmount(app!);
		app = undefined;
		host.textContent = '';
		list.mockReset();

		await render(DEVELOPER, []);
		expect(host.textContent).toContain('blocks_empty');
		// Two: the header's and the empty state's — an empty library shows both call sites at once,
		// which is exactly why gating only one of them would have left the defect half-alive.
		expect(newBlockButtons().length, 'the empty-state CTA disappeared for its author').toBe(2);
	});

	it('the library itself is unchanged for a member — this gates authoring, not reading', async () => {
		// `GET /api/blocks` is bare `validateAuth` (blocks.ts:277) and the nav lists /blocks with no
		// role gate at all. A fix that emptied the catalog for members would be a worse defect.
		await render(MEMBER, [block('a-block')]);
		expect(host.querySelectorAll('button.block-card').length).toBe(1);
		expect(host.textContent).toContain('a-block');
	});
});

// Round 2 (member Library): a member reads a block's name, description and status. The version
// number and the ontology entity KEY a data block was derived from are author detail.
describe('/blocks hides author detail from a member', () => {
	const derived = (): BlockListItem => ({ ...block('a-block'), source_entity_key: 'insurance:claims:claim_record' });

	it('a member sees the status but no version and no entity key', async () => {
		await render(MEMBER, [derived()]);
		const ver = host.querySelector('.block-card-ver')?.textContent ?? '';
		expect(ver, 'the status line did not render, so this case proves nothing').not.toBe('');
		expect(ver).not.toContain('1.0.0');
		expect(host.textContent).not.toContain('claim_record');
		expect(host.textContent).not.toContain('blocks_derived_from');
	});

	it('a developer still sees both — the over-correction guard', async () => {
		await render(DEVELOPER, [derived()]);
		expect(host.querySelector('.block-card-ver')?.textContent).toContain('1.0.0');
		expect(host.textContent).toContain('blocks_derived_from:claim_record');
	});
});
