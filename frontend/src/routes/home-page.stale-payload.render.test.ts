// @vitest-environment jsdom
//
// src/routes/home-page.stale-payload.render.test.ts — Home, rendered by a NEW frontend against
// an OLD backend. This file is the guard for a whole CLASS of defect, not for one label.
//
// ⛔ WHY THIS FILE EXISTS — THE DEPLOY MODEL. Backend and frontend are separate images and roll
// independently, so for the length of EVERY roll a new frontend is answered by an old backend.
// This repo already treats that as a fact rather than a hypothetical: see
// backend/src/host/pipeline-service.ts:41-47, which keeps a dead `label` field on the wire for
// exactly one deploy window because "backend and frontend are separate images, so an OLD frontend
// talks to a NEW backend on every roll, and dropping the field now would make that frontend
// render 'undefined' across the whole timeline." The same window exists in the other direction,
// and it is the one this file covers.
//
// ⛔ WHY IT BITES HERE SPECIFICALLY. Paraglide compiles the catalog to RAW INTERPOLATION with no
// nullish guard anywhere on the path — src/lib/paraglide/messages/home_activity_voted_on.js is
// literally `(i) => `You voted on (${i?.count})``. The `?.` guards the INPUT OBJECT, never the
// FIELD. So an old `/api/home/summary` payload — one with no `*Total` keys at all — put the
// literal word "undefined" on the product's first screen:
//
//     You voted on (undefined)
//
// Reading the total off the slice was WRONG (a page size dressed as a count, the bug fixed in
// "You voted on (8)" was the LIMIT, not the count). Reading it off a missing field is BROKEN.
// The fix must degrade to the old wrong-but-readable behaviour, never to the broken one.
//
// ⛔ THIS FILE USES THE REAL COMPILED CATALOG — no `vi.mock('$lib/paraglide/messages')`. The
// token-mocking technique the sibling render tests use would hide the exact thing under test:
// a mock renders `home_activity_voted_on:undefined`, which still LOOKS like a message. Only the
// real compiled interpolation shows the user-visible string, so the assertions here are on
// literal rendered English.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { HomeSummary } from '$lib/types/marketplace';

const { home } = vi.hoisted(() => ({ home: vi.fn() }));
// ⛔ ALIAS module ids, never relative ones.
vi.mock('$lib/api/marketplace', () => ({ marketplaceApi: { home, winner: vi.fn() } }));
// Home also reads the reader's draft flows (the "Continue building" step); none here.
vi.mock('$lib/api/flows', () => ({ flowsApi: { list: () => Promise.resolve({ items: [], total: 0 }) } }));
vi.mock('$lib/api/challenges', () => ({
	challengesApi: { list: vi.fn(), vote: vi.fn(), unvote: vi.fn() }
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback
}));
vi.mock('$lib/i18n/reload-on-locale.svelte', () => ({ reloadOnLocaleChange: () => {} }));
vi.mock('$lib/stores/auth.svelte', () => ({
	auth: { user: { id: 'u1', email: 'u@t', name: 'U', roles: ['employee'] } }
}));

import Page from './+page.svelte';

function activity(n: number, prefix: string) {
	return Array.from({ length: n }, (_, i) => ({
		id: `${prefix}-${i}`,
		code: `${prefix.toUpperCase()}-${i}`,
		title: `${prefix} ${i}`,
		votesCount: i
	}));
}

/**
 * The PRE-CHANGE payload, byte-for-byte in shape: `/api/home/summary` as it looked before
 * `submittedTotal` / `votedOnTotal` existed. The keys are ABSENT, not null — that is what an old
 * backend actually puts on the wire, and `?? ` is the only thing that can catch it.
 *
 * Typed through `HomeSummary` deliberately: the cast is the point. The compiler says these fields
 * are always there; the deploy window says otherwise, and the deploy window wins at runtime.
 */
function stalePayload(votedShown: number, submittedShown: number): HomeSummary {
	return {
		stats: { activeChallenges: 0, solutionsInVoting: 0, activeBuilders: 0, liveInProduction: 0 },
		trending: [],
		cycle: null,
		yourActivity: {
			submitted: activity(submittedShown, 'sub'),
			votedOn: activity(votedShown, 'vote')
		}
	} as unknown as HomeSummary;
}

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

async function render(payload: HomeSummary) {
	home.mockResolvedValue(payload);
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
	const text = host.textContent ?? '';
	// Non-vacuity: if the activity card never mounted, every "does not contain" below is free.
	expect(text, 'the activity card never rendered, so this file tests nothing').toContain(
		'My activity'
	);
	return text;
}

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
	home.mockReset();
});

describe('Home survives an old backend (mid-roll, no `*Total` keys on the wire)', () => {
	it('renders the pre-change number, never the literal word "undefined"', async () => {
		const text = await render(stalePayload(8, 5));
		// The OLD behaviour, restored exactly: the page size, shown as a count. Wrong, readable.
		expect(text).toContain('Voted on (8)');
		// THE REGRESSION. Nothing on this screen may ever say "undefined" to a user.
		expect(text).not.toContain('undefined');
	});

	it('keeps the truncation hint hidden — an absent total cannot invent a "showing 8 of undefined"', async () => {
		const text = await render(stalePayload(8, 5));
		// Asserted on the ELEMENT, not on the copy: the hint's wording is owned by the catalog and
		// gets reworded (it did, in the very next commit); its ABSENCE here is the invariant.
		expect(host.querySelectorAll('.act-more')).toHaveLength(0);
		expect(text).not.toContain('undefined');
	});

	it('does not say "undefined" on an empty stale payload either', async () => {
		const text = await render(stalePayload(0, 0));
		expect(text).toContain('Voted on (0)');
		expect(text).not.toContain('undefined');
		expect(host.querySelectorAll('.act-more')).toHaveLength(0);
	});
});
