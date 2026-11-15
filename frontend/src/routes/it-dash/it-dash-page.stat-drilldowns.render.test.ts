// @vitest-environment jsdom
//
// src/routes/it-dash/it-dash-page.stat-drilldowns.render.test.ts — which /it-dash stat cards offer
// a drill-down, and what they claim to count.
//
// ⛔ THE DEFECT. "Daily LLM calls" and "Spend today" carried `href="/usage"`, and
// `StatCard.svelte` renders any href as an `<a>` with a `→`. The two screens answer DIFFERENT
// questions on four independent axes (the comment table lives in backend/src/host/ops-metrics.ts):
//
//     this card                     /usage
//     ALL tenants                   ONE tenant
//     today                         last 30 days (default)
//     human + platform LLM calls    human only (`NOT ue.platform_actor`)
//     usage_counters                the usage_events ledger
//
// ⛔ THE SYMPTOM IS "UNRELATED", NOT "SMALLER" — do not rewrite this file's assertions around a
// magnitude. Thirty days of one tenant's human calls can exceed one day of fleet-wide calls, so
// the reader is not even given a number that shrank; they are given a plausible different number.
//
// ⛔ AND IT IS NOT A REACHABILITY BUG, so `canReachNav()` (navConfig.ts) is the wrong helper.
// `roleAllows` is composite — super_admin ⊇ tenant_admin — and /usage is gated `tenant_admin`, so
// the super_admin reading /it-dash reaches /usage fine. Nothing 403s. The link is simply about
// something else.
//
// Harness (mocks, dto, settle) mirrors `it-dash-page.i18n.render.test.ts`: messages are mocked from
// the base catalog with each key returning ITS OWN NAME, so a sub-label assertion names a key
// rather than pinning copy a translator may reword.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { Dashboard } from '$lib/types/ops';

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

const { getDashboard, FakeApiError } = vi.hoisted(() => ({
	getDashboard: vi.fn(),
	FakeApiError: class extends Error {
		status = 0;
	}
}));
vi.mock('$lib/api/ops', () => ({
	opsApi: { dashboard: getDashboard },
	ApiError: FakeApiError
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

import Page from './+page.svelte';

const TS = '2026-08-12T04:00:00.000Z';

/** The minimum real payload that renders the loaded body: all four stat cards + one of each panel. */
function dto(): Dashboard {
	return {
		stats: { activeSandboxes: 9, dailyLlmCalls: 421, spendTodayUsd: 3.4, p95LatencyMs: 2474 },
		health: {
			buckets: Array.from({ length: 24 }, (_, i) => ({
				hourTs: new Date(Date.UTC(2026, 7, 11, i)).toISOString(),
				activeRuns: i,
				llmCalls: i * 2
			}))
		},
		topBlocks: [{ slug: 'triage-claim', name: 'Claim triage', category: 'ai', count: 12, pct: 100 }],
		attention: [
			{
				kind: 'high_latency',
				p95Ms: 2474,
				thresholdMs: 2000,
				title: 'P95 latency rising',
				detail: '24h P95 is 2.47s, above the 2.0s target.'
			}
		],
		events: [
			{
				kind: 'run_finished' as const,
				flow: 'Weekly intake',
				runStatus: 'ok',
				actor: 'Lisa de Vries',
				text: 'ran Weekly intake → ok',
				ts: TS
			}
		]
	};
}

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	getDashboard.mockReset();
	getDashboard.mockResolvedValue(dto());
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
});

async function render() {
	app = mount(Page, { target: host, props: {} });
	flushSync();
	await Promise.resolve();
	await Promise.resolve();
	flushSync();
	return host;
}

/**
 * ⛔ THE ANTI-VACUITY GATE. /it-dash opens in a `{#if loading}` branch that renders ONE notice and
 * no stat cards at all — under which `hrefs().not.toContain('/usage')` is true and asserts nothing.
 * Every case below goes through here, and it demands all FOUR cards, by count.
 */
function statCards(el: HTMLElement): HTMLElement[] {
	expect(getDashboard, 'the dashboard API was never called').toHaveBeenCalled();
	expect(el.textContent, 'the page never left its loading branch').toContain(
		'itdash_section_needs_attention'
	);
	const cards = [...el.querySelectorAll<HTMLElement>('.stats .stat')];
	expect(cards.length, 'the stat row did not render four cards').toBe(4);
	return cards;
}

/** The href of every stat card, `null` for the ones rendered as a plain `<div>`. */
function hrefs(el: HTMLElement): (string | null)[] {
	return statCards(el).map((c) => c.getAttribute('href'));
}

describe('/it-dash stat cards only link where the link answers the card', () => {
	it('⛔ the fleet-wide LLM and spend cards do not offer a per-tenant drill-down', async () => {
		const el = await render();
		const all = hrefs(el);
		expect(all).not.toContain('/usage');
		// And the two are inert, not merely pointed elsewhere: no `<a>`, so no `→` affordance
		// promising a destination.
		const linked = statCards(el).filter((c) => c.tagName === 'A');
		expect(linked).toHaveLength(2);
	});

	it('…and they say which population they count', async () => {
		const el = await render();
		statCards(el);
		// `itdash_stat_today` said only "today" — a super_admin reading "Spend today" had no way to
		// know the figure spans every tenant and folds in platform background traffic. It does now.
		const subs = statCards(el).map((c) => c.querySelector('.stat-delta')?.textContent);
		expect(subs.filter((s) => s === 'itdash_stat_today_all_tenants')).toHaveLength(2);
		expect(subs).not.toContain('itdash_stat_today');
	});

	it('the drill-downs that DO answer their own card survive', async () => {
		// ⛔ LOAD-BEARING. The two cases above are both satisfied by a page that renders no cards
		// (blocked by the gate) *and* by deleting `StatCard`'s `href` prop outright — which would
		// silently strip the two honest links as well. "Active sandboxes → /sandboxes" and
		// "P95 latency → /audit?category=sandbox" go to screens about the same population and the
		// same window, and must still be there.
		const el = await render();
		const all = hrefs(el);
		expect(all).toContain('/sandboxes');
		expect(all).toContain('/audit?category=sandbox');
	});
});
