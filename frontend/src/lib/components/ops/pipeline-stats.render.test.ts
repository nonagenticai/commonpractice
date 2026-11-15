// @vitest-environment jsdom
//
// src/lib/components/ops/pipeline-stats.render.test.ts — what the four /pipeline stat cards
// actually render.
//
// ⛔ THE DEFECT. Live in production: "GEM. TIJD TOT LIVE — / nog niets live" rendered directly
// beside "IN PRODUCTIE 1 / nu live". The single production card had shipped in 41 minutes; the
// server divided by a day and rounded (→ 0), and `+page.svelte` then used that MAGNITUDE as a
// data-existence predicate — `avgTimeToLiveDays > 0`, twice, once for the value and once for the
// sub-label. A duration of zero is not the statement "nothing has shipped". The row now branches on
// `metrics.liveCount`, which is the existence fact itself.
//
// This file is a BEHAVIOURAL assertion, which is why the row was extracted out of `+page.svelte` in
// the first place: that page runs `onMount(load)` and calls the API, so it cannot be mounted
// cleanly here, and a source grep (the honest-but-limited shape of
// routes/pipeline/pipeline-page.no-reviewer-count.test.ts) could only approximate a rendering rule.
//
// Assertions are on WHICH KEY, not on English copy — the messages module is mocked so every key
// returns its own name (same technique as kanban-card.review-control.render.test.ts).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { PipelineMetrics } from '$lib/types/pipeline';

vi.mock('$lib/paraglide/messages', () => ({
	pipeline_stat_in_pipeline: () => 'IN_PIPELINE',
	pipeline_stat_not_yet_live: () => 'NOT_YET_LIVE',
	pipeline_stat_avg_time_to_live: () => 'AVG_TIME_TO_LIVE',
	pipeline_stat_across_shipped: () => 'ACROSS_SHIPPED',
	pipeline_stat_no_live_yet: () => 'NO_LIVE_YET',
	pipeline_stat_in_production: () => 'IN_PRODUCTION',
	pipeline_stat_live_now: () => 'LIVE_NOW',
	pipeline_stat_rolled_back: () => 'ROLLED_BACK',
	pipeline_stat_this_quarter: () => 'THIS_QUARTER',
	pipeline_dur_min: ({ count }: { count: number }) => `DUR_MIN:${count}`,
	pipeline_dur_hour: ({ count }: { count: number }) => `DUR_HOUR:${count}`,
	pipeline_dur_day: ({ count }: { count: number }) => `DUR_DAY:${count}`,
	timeago_sec: () => 'sec',
	timeago_min: () => 'min',
	timeago_hour: () => 'hour',
	timeago_hour_min: () => 'hourmin',
	timeago_day: () => 'day',
	timeago_day_hour: () => 'dayhour'
}));

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
});

async function render(metrics: PipelineMetrics) {
	const { default: PipelineStats } = await import('./PipelineStats.svelte');
	app = mount(PipelineStats, { target: host, props: { metrics } });
	flushSync();
	return host;
}

/** The value rendered on the "avg time to live" card, and the sub-label under it. */
function avgCard(el: HTMLElement) {
	const cards = [...el.querySelectorAll('.stat')];
	const card = cards.find((c) => c.querySelector('.stat-label')?.textContent === 'AVG_TIME_TO_LIVE');
	expect(card, 'no stat card labelled AVG_TIME_TO_LIVE — this file is asserting about nothing').toBeTruthy();
	return {
		value: card!.querySelector('.stat-value')!.textContent,
		sub: card!.querySelector('.stat-delta')?.textContent ?? null
	};
}

describe('the avg-time-to-live card branches on liveCount, not on the size of the number', () => {
	it('THE PROD CASE — one card shipped in 41 minutes renders the duration, not "—"', async () => {
		const el = await render({
			inPipeline: 1,
			inProduction: 1,
			rolledBack: 0,
			// Whole days still rounds a 41-minute ship to ZERO. Under the old code this exact metrics
			// object produced "— / none live yet" next to "in production 1 / live now".
			avgTimeToLiveDays: 0,
			liveCount: 1,
			avgTimeToLiveMs: 2_460_000
		});
		const { value, sub } = avgCard(el);
		expect(value).toBe('DUR_MIN:41');
		expect(value).not.toBe('—');
		expect(sub).toBe('ACROSS_SHIPPED');
		// …and the contradiction it stood beside is gone: the "in production 1" card is still there.
		expect(el.textContent).toContain('IN_PRODUCTION');
	});

	it('a NEW backend reporting nothing shipped renders "—" + no-live-yet', async () => {
		const el = await render({
			inPipeline: 3,
			inProduction: 0,
			rolledBack: 0,
			avgTimeToLiveDays: 0,
			liveCount: 0,
			// `null`, not `0`: the empty case must not be expressible as a duration, or the conflation
			// the whole change removes comes straight back.
			avgTimeToLiveMs: null
		});
		const { value, sub } = avgCard(el);
		expect(value).toBe('—');
		expect(sub).toBe('NO_LIVE_YET');
	});

	it('a live card whose interval really is under a minute still counts as shipped', async () => {
		// The point of separating existence from magnitude: `avgTimeToLiveMs === 0` is DATA.
		const el = await render({
			inPipeline: 0,
			inProduction: 1,
			rolledBack: 0,
			avgTimeToLiveDays: 0,
			liveCount: 1,
			avgTimeToLiveMs: 0
		});
		const { value, sub } = avgCard(el);
		expect(value).toBe('DUR_MIN:0');
		expect(sub).toBe('ACROSS_SHIPPED');
	});
});

// T5 — the deploy window. Backend and frontend are separate images; a new frontend talks to an old
// backend on every roll, and the old backend sends NO `liveCount` and NO `avgTimeToLiveMs`.
describe('the pre-fix fallback still renders when the backend has not rolled', () => {
	it('renders "—" + no-live-yet for an old-backend metrics object, without crashing', async () => {
		const metrics = {
			inPipeline: 2,
			inProduction: 1,
			rolledBack: 0,
			avgTimeToLiveDays: 0
			// no liveCount, no avgTimeToLiveMs — exactly what an un-rolled backend sends.
		} as PipelineMetrics;
		expect('liveCount' in metrics, 'the fixture must NOT carry liveCount or this test is vacuous').toBe(false);

		const el = await render(metrics);
		const { value, sub } = avgCard(el);
		// Verbatim old behaviour. It is the same contradiction as before — and it must be, because a
		// backend that cannot answer "how many shipped" gives the browser nothing better to say. It
		// lasts one deploy window instead of forever.
		expect(value).toBe('—');
		expect(sub).toBe('NO_LIVE_YET');
		// The rest of the row is unaffected, i.e. the page did not blank out on the missing fields.
		expect(el.textContent).toContain('IN_PIPELINE');
		expect(el.textContent).toContain('ROLLED_BACK');
	});

	it('an old backend WITH a multi-day average still reproduces the old `{n}d` output', async () => {
		const metrics = { inPipeline: 2, inProduction: 5, rolledBack: 1, avgTimeToLiveDays: 3 } as PipelineMetrics;
		const el = await render(metrics);
		const { value, sub } = avgCard(el);
		expect(value).toBe('3d');
		expect(sub).toBe('ACROSS_SHIPPED');
	});
});
