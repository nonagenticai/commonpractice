// @vitest-environment jsdom
//
// src/routes/home-page.cycle-cadence.render.test.ts — the home screen follows the voting-cycle
// cadence (backend `cycle.cadence`, 0107, folded into /api/home/summary as `cadence`).
//
//   • OFF: no cadence section at all — there is no period and no rhythm to draw.
//   • MONTH / YEAR: the section renders ONE phase bar (voting → building), not Mon–Fri day cards.
//   • WEEK, and an older backend with no `cadence`: unchanged five-card strip — WHEN a cycle row exists.
//   • WEEK / no `cadence` with NO cycle row (a brand-new org): no section at all.
//   • MONTH / YEAR with no cycle row (period not opened yet): a neutral line, no day cards.
//
// Rendered through the real page and the real CadenceStrip, so the wiring at both call sites is
// what is tested. Restoring the original home markup (the section with no `{#if}`) reddens OFF.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { HomeSummary } from '$lib/types/marketplace';
import type { CycleState } from '$lib/types/cycle';

const { home } = vi.hoisted(() => ({ home: vi.fn() }));
vi.mock('$lib/api/marketplace', () => ({ marketplaceApi: { home, winner: vi.fn() } }));
vi.mock('$lib/api/challenges', () => ({
	challengesApi: { list: vi.fn(), vote: vi.fn(), unvote: vi.fn() }
}));
vi.mock('$lib/api/error-message', () => ({ errorText: (_e: unknown, fallback: string) => fallback }));
vi.mock('$lib/i18n/reload-on-locale.svelte', () => ({ reloadOnLocaleChange: () => {} }));
vi.mock('$lib/stores/auth.svelte', () => ({
	auth: { user: { id: 'u1', email: 'u@t', name: 'U', roles: ['employee'] } }
}));
vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')) as Record<string, string>;
	const mod: Record<string, unknown> = {};
	// Each message renders as its KEY, so the assertions name the exact copy a branch chose.
	for (const key of Object.keys(catalog)) if (key !== '$schema') mod[key] = () => key;
	return mod;
});

import Page from './+page.svelte';

const DAY = 86_400_000;
const KEY = { week: '2026-W42', month: '2026-10', quarter: '2026-Q4', year: '2026' } as const;
function cycle(kind: 'week' | 'month' | 'quarter' | 'year'): CycleState {
	const now = Date.now();
	const start = new Date(now - 5 * DAY).toISOString();
	return {
		week: KEY[kind],
		periodKind: kind,
		periodKey: KEY[kind],
		periodStart: start,
		phase: 'voting',
		votingEndsAt: new Date(now + 5 * DAY).toISOString(),
		solutionEndsAt: new Date(now + 15 * DAY).toISOString(),
		closesAt: new Date(now + 15 * DAY).toISOString()
	};
}
function summary(over: Partial<HomeSummary>): HomeSummary {
	return {
		stats: { activeChallenges: 0, solutionsInVoting: 0, activeBuilders: 0, liveInProduction: 0 },
		trending: [],
		cycle: null,
		yourActivity: { submitted: [], submittedTotal: 0, votedOn: [], votedOnTotal: 0 },
		...over
	};
}

let host: HTMLElement;
let app: Record<string, unknown> | undefined;
async function render(s: HomeSummary) {
	home.mockResolvedValue(s);
	host = document.createElement('div');
	document.body.appendChild(host);
	app = mount(Page, { target: host }) as Record<string, unknown>;
	for (let i = 0; i < 6; i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
}
beforeEach(() => home.mockReset());
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host?.remove();
});

const section = () => host.querySelector('.cadence-section');
const dayCards = () => host.querySelectorAll('.cadence .day').length;
const bar = () => host.querySelector('[data-testid="cadence-period-bar"]');

describe('home · voting cycle cadence', () => {
	it('⛔ OFF: the cadence section is not rendered at all', async () => {
		await render(summary({ cadence: { setting: 'off', effective: 'off' } }));
		expect(host.textContent, 'the page rendered').toContain('home_');
		expect(section()).toBeNull();
		expect(dayCards()).toBe(0);
	});

	it('MONTH: one phase bar, titled for the month, no day cards', async () => {
		await render(summary({ cadence: { setting: 'month', effective: 'month' }, cycle: cycle('month') }));
		expect(section()).not.toBeNull();
		expect(section()!.querySelector('h2')!.textContent!.trim()).toBe('cadence_title_month');
		expect(bar()).not.toBeNull();
		expect(dayCards()).toBe(0);
		// voting = 10 of 20 days → the voting segment is half the bar.
		const voting = bar()!.querySelector<HTMLElement>('.pb-seg.voting')!;
		expect(Number.parseFloat(voting.style.width)).toBeCloseTo(50, 0);
	});

	it('QUARTER: one phase bar, titled for the quarter, no day cards', async () => {
		await render(summary({ cadence: { setting: 'quarter', effective: 'quarter' }, cycle: cycle('quarter') }));
		expect(section()!.querySelector('h2')!.textContent!.trim()).toBe('cadence_title_quarter');
		expect(bar()).not.toBeNull();
		expect(dayCards()).toBe(0);
	});

	it('YEAR: phase bar, titled for the year', async () => {
		await render(summary({ cadence: { setting: 'year', effective: 'year' }, cycle: cycle('year') }));
		expect(section()!.querySelector('h2')!.textContent!.trim()).toBe('cadence_title_year');
		expect(bar()).not.toBeNull();
	});

	it('WEEK, and an older backend with no cadence field: the five day cards, no bar', async () => {
		await render(summary({ cadence: { setting: 'week', effective: 'week' }, cycle: cycle('week') }));
		expect(dayCards()).toBe(5);
		expect(bar()).toBeNull();
		unmount(app!);
		app = undefined;
		host.remove();
		await render(summary({ cycle: cycle('week') }));
		expect(section()).not.toBeNull();
		expect(section()!.querySelector('h2')!.textContent!.trim()).toBe('home_cadence_title');
		expect(dayCards()).toBe(5);
	});

	// ⛔ A brand-new org has no cycle row. The strip used to fall back to five fixed day cards — the
	// demo company's "1h vibe-coding" / "Guest talk" / "14:30 · CTO café" — lit by today's weekday,
	// read on prod 2026-10-16 by a new external org as its own schedule. No row = nothing real = no
	// section, for a weekly cadence and for an older backend with no cadence field alike.
	it('⛔ WEEK (or no cadence field) with NO cycle row: no section, no day cards, no ritual copy', async () => {
		for (const over of [{ cadence: { setting: 'week', effective: 'week' } }, {}] as Partial<HomeSummary>[]) {
			await render(summary({ ...over, cycle: null }));
			expect(host.textContent, 'the page rendered').toContain('home_');
			expect(section()).toBeNull();
			expect(dayCards()).toBe(0);
			expect(host.textContent).not.toContain('mkt_cadence_');
			unmount(app!);
			app = undefined;
			host.remove();
		}
	});

	it('⛔ MONTH / YEAR with NO cycle row yet: a neutral line — never the weekly title or day cards', async () => {
		for (const kind of ['month', 'quarter', 'year'] as const) {
			await render(summary({ cadence: { setting: kind, effective: kind }, cycle: null }));
			expect(section(), `${kind}: section`).not.toBeNull();
			expect(section()!.querySelector('h2')!.textContent!.trim()).toBe(`cadence_title_${kind}`);
			expect(dayCards(), `${kind}: no Mon–Fri cards`).toBe(0);
			expect(bar()).toBeNull();
			expect(host.querySelector('[data-testid="cadence-period-waiting"]')?.textContent?.trim()).toBe(
				'cadence_waiting'
			);
			unmount(app!);
			app = undefined;
			host.remove();
		}
	});
});
