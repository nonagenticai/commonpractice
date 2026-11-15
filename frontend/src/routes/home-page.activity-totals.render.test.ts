// @vitest-environment jsdom
//
// src/routes/home-page.activity-totals.render.test.ts — the "Your activity" card's NUMBER.
//
// ⛔ THE REGRESSION. `/api/home/summary` returns `votedOn` as a LIMIT 8 slice, and the card
// rendered `m.home_activity_voted_on({ count: data.yourActivity.votedOn.length })` — a PAGE SIZE
// dressed as a count. A user who had voted on 30 challenges was told "You voted on (8)", forever,
// on the product's first screen. The payload now carries `votedOnTotal` (a real, joined count) and
// the label must read from it.
//
// The truncation line is the other half: once the label says 30 and the list shows 8, the missing
// 22 need somewhere to go, so `home_activity_showing_of` links to /challenges — and it must stay
// out of the way entirely when nothing is actually hidden.
//
// Assertions are on MESSAGE TOKENS (`key:param,param`), never on English copy, so a reworded
// catalog cannot red this and a hardcoded English label cannot pass it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { HomeSummary } from '$lib/types/marketplace';

// Real `en` catalog, each key resolving to its own name — see solutions-page.vote-control.render.
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
// The real store pulls in keycloak; the page only reads `auth.user?.roles` (to decide whether the
// "Live in production" stat card links to /pipeline), which is irrelevant to this file.
vi.mock('$lib/stores/auth.svelte', () => ({
	auth: { user: { id: 'u1', email: 'u@t', name: 'U', roles: ['employee'] } }
}));

import Page from './+page.svelte';

function activity(shown: number, prefix: string) {
	return Array.from({ length: shown }, (_, i) => ({
		id: `${prefix}-${i}`,
		code: `${prefix.toUpperCase()}-${i}`,
		title: `${prefix} ${i}`,
		votesCount: i
	}));
}

function summary(opts: {
	votedShown: number;
	votedTotal: number;
	submittedShown: number;
	submittedTotal: number;
}): HomeSummary {
	return {
		stats: { activeChallenges: 0, solutionsInVoting: 0, activeBuilders: 0, liveInProduction: 0 },
		trending: [],
		cycle: null,
		yourActivity: {
			submitted: activity(opts.submittedShown, 'sub'),
			submittedTotal: opts.submittedTotal,
			votedOn: activity(opts.votedShown, 'vote'),
			votedOnTotal: opts.votedTotal
		}
	};
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
	expect(text, 'the activity card never rendered, so this file tests nothing').toContain(
		'home_activity_title'
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

describe('Home "Your activity" renders totals, not page sizes', () => {
	it('the vote label carries the real total, not the length of the 8-row slice', async () => {
		const text = await render(
			summary({ votedShown: 8, votedTotal: 30, submittedShown: 5, submittedTotal: 12 })
		);
		expect(text).toContain('home_activity_voted_on:30');
		// The shipped bug, spelled out: 8 is the LIMIT, and it must never reach the label.
		expect(text).not.toContain('home_activity_voted_on:8');
	});

	// ⛔ THE HINT STATES A COUNT. IT DOES NOT OFFER A DESTINATION — and it must not grow one back
	// until the backend can actually serve it.
	//
	// It shipped as `<a class="act-more" href="/challenges">Showing 8 of 30 — see all</a>`, which
	// promised retrieval the product cannot do. GET /api/challenges accepts exactly `work_area`,
	// `status`, `sort`, `q`, `page` (backend/src/routes/challenges.ts:248-290; the client mirrors
	// that list in $lib/api/challenges.ts) — there is NO "mine" filter and NO "voted-by-me"
	// filter. So "see all" landed the reader on page 1 of a tenant-wide leaderboard, PAGE_SIZE 10,
	// default sort `top`, with no way to isolate their own 30 — and BOTH hints pointed at the same
	// undifferentiated place, so the submitted hint and the voted hint were indistinguishable.
	//
	// The count is the valuable part and it stays. Add a voted-by-me / mine filter to
	// routes/challenges.ts and this copy can be upgraded back to a real link.
	it('states the real total as plain text — no link, because /challenges cannot filter to "mine"', async () => {
		const text = await render(
			summary({ votedShown: 8, votedTotal: 30, submittedShown: 5, submittedTotal: 12 })
		);
		expect(text).toContain('home_activity_showing_of:8,30');
		expect(text).toContain('home_activity_showing_of:5,12');
		const hints = [...host.querySelectorAll('.act-more')];
		expect(hints).toHaveLength(2);
		// Not an anchor itself, and not wrapping one.
		for (const el of hints) expect(el.tagName).not.toBe('A');
		expect(host.querySelectorAll('.act-more a')).toHaveLength(0);
		// Nothing in the activity card sends the reader to the unfiltered leaderboard under the
		// pretence that their own rows are waiting there.
		const cardLinks = [...host.querySelectorAll('.act-block a')] as HTMLAnchorElement[];
		expect(cardLinks.map((a) => a.getAttribute('href'))).not.toContain('/challenges');
	});

	it('does NOT render the truncation hint when the whole list fits', async () => {
		const text = await render(
			summary({ votedShown: 3, votedTotal: 3, submittedShown: 2, submittedTotal: 2 })
		);
		expect(text).toContain('home_activity_voted_on:3');
		expect(text).not.toContain('home_activity_showing_of');
		expect(host.querySelectorAll('a.act-more')).toHaveLength(0);
	});
});
