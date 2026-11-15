// @vitest-environment jsdom
//
// src/routes/it-dash/it-dash-page.i18n.render.test.ts — the whole /it-dash screen, in a non-English
// locale, with the backend answering exactly what production answers.
//
// ⛔ THE DEFECT, end to end. Captured live: a Dutch frame around two English panels. "Aandacht
// nodig" and "Recente platformgebeurtenissen" were localized; under them sat "3 sandboxes in
// error", "24h P95 is 2.47s, above the 2.0s target.", "triage-claim failing repeatedly" and eight
// feed rows reading "published X v1.2.0" / "ran Y → ok". The DTOs below are the REAL payloads —
// the English `title` / `detail` / `text` the backend still sends are all present and populated —
// and the assertions are "this English string is NOT in the document".
//
// Messages are mocked from the base catalog with each key returning ITS OWN NAME (the technique in
// routes/governance/governance-page.i18n.render.test.ts): the rendered document is then a list of
// message keys, so a test states WHICH message each region resolved without pinning Dutch copy a
// translator may reword. A key missing from the catalog renders `undefined` and fails loudly
// rather than silently falling back.
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

/** Every sentence backend/src/host/ops-metrics.ts still composes, copied verbatim from it. */
const ENGLISH_PROSE = [
	'3 sandboxes in error',
	'P95 latency rising',
	'24h P95 is 2.47s, above the 2.0s target.',
	'triage-claim failing repeatedly',
	'4 errored runs in the last 7 days hit the same block.',
	'rows-to-csv failing repeatedly',
	'2 errored runs in the last 7 days hit the same block.',
	'published triage-claim v1.2.0',
	'ran Weekly intake → ok',
	'sandbox suspended · Email auto-categorize'
];

const TS = '2026-08-12T04:00:00.000Z';

/** The NEW payload: machine fields AND the deprecated prose, exactly as the backend ships it. */
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
		// `name` tracks the DTO (`ops-metrics.ts TopBlock`). It is DELIBERATELY unlike the slug here:
		// the seed sets `name === slug` for every platform block, so a fixture copied from the demo
		// database cannot tell "the bar renders the name" from "the bar renders the slug".
		topBlocks: [
			{ slug: 'triage-claim', name: 'Schadeclaim-triage', category: 'ai', count: 12, pct: 100 }
		],
		attention: [
			{
				kind: 'sandbox_error',
				errorCount: 3,
				owners: [
					{ name: 'Fatima Hassani', project: 'Email auto-categorize' },
					{ name: 'Lisa de Vries', project: null },
					{ name: 'Ada Lovelace', project: 'Claims intake' }
				],
				title: '3 sandboxes in error',
				detail:
					'Fatima Hassani · Email auto-categorize; Lisa de Vries; Ada Lovelace · Claims intake',
				href: '/sandboxes?status=error'
			},
			{
				kind: 'high_latency',
				p95Ms: 2474,
				thresholdMs: 2000,
				title: 'P95 latency rising',
				detail: '24h P95 is 2.47s, above the 2.0s target.'
			},
			{
				kind: 'block_errors',
				slug: 'triage-claim',
				runCount: 4,
				windowDays: 7,
				title: 'triage-claim failing repeatedly',
				detail: '4 errored runs in the last 7 days hit the same block.',
				href: '/block-edit?slug=triage-claim'
			},
			// ⛔ A SECOND `block_errors` ROW, AND IT IS LOAD-BEARING. `getAttention` returns up to
			// THREE (`ORDER BY n DESC LIMIT 3`), one per failing block, so two rows of this kind is
			// the ROUTINE production shape. Without it the fixture has three distinct kinds, the
			// `(a.kind)` mutation does not duplicate, and the rolling-deploy guard below passes
			// green against the exact edit it exists to stop — measured, not hypothesised.
			{
				kind: 'block_errors',
				slug: 'rows-to-csv',
				runCount: 2,
				windowDays: 7,
				title: 'rows-to-csv failing repeatedly',
				detail: '2 errored runs in the last 7 days hit the same block.',
				href: '/block-edit?slug=rows-to-csv'
			}
		],
		events: [
			...Array.from({ length: 6 }, (_, i) => ({
				kind: 'block_published' as const,
				block: 'triage-claim',
				version: '1.2.0',
				actor: 'Common Practice',
				text: 'published triage-claim v1.2.0',
				ts: TS,
				href: `/block-edit?slug=triage-claim&i=${i}`
			})),
			{
				kind: 'run_finished' as const,
				flow: 'Weekly intake',
				runStatus: 'ok',
				actor: 'Lisa de Vries',
				text: 'ran Weekly intake → ok',
				ts: TS
			},
			{
				kind: 'sandbox_suspended' as const,
				project: 'Email auto-categorize',
				actor: 'Fatima Hassani',
				text: 'sandbox suspended · Email auto-categorize',
				ts: TS
			}
		]
	};
}

/**
 * ⛔ THE VERBATIM PRE-CHANGE PAYLOAD. Not "the new DTO with some fields cleared" — the exact object
 * shape `git show HEAD~:backend/src/host/ops-metrics.ts` produces: kind, title/detail (or
 * actor/text/ts), href, and NOTHING else. This is what a NEW frontend gets from an OLD pod while
 * the Deployment rolls, because the browser reaches the API through the Service.
 */
function legacyDto(): Dashboard {
	const d = dto();
	d.attention = d.attention.map((a) => ({
		kind: a.kind,
		title: a.title,
		detail: a.detail,
		...(a.href ? { href: a.href } : {})
	})) as Dashboard['attention'];
	d.events = d.events.map((e) => ({
		kind: e.kind,
		actor: e.actor,
		text: e.text,
		ts: e.ts,
		...(e.href ? { href: e.href } : {})
	})) as Dashboard['events'];
	return d;
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
 * ⛔ THE ANTI-VACUITY GATE, used by every assertion in this file.
 *
 * `/it-dash` starts in a `{#if loading}` branch that renders one `<div class="notice">`. If the
 * mocked API never resolves, or `onMount` does not fire, the document contains none of the English
 * prose — and every `not.toContain` below passes while asserting nothing at all. So: prove the
 * page LEFT that branch, by a positive marker that only the loaded body renders.
 */
function assertLoaded(el: HTMLElement) {
	expect(getDashboard, 'the dashboard API was never called').toHaveBeenCalled();
	expect(el.textContent, 'the page never left its loading branch').toContain(
		'itdash_section_needs_attention'
	);
	expect(el.textContent).toContain('itdash_section_recent_events');
}

describe('/it-dash renders no English body inside its localized frame', () => {
	it('shows not one of the backend’s English sentences', async () => {
		const el = await render();
		assertLoaded(el);

		const offenders = ENGLISH_PROSE.filter((s) => el.textContent!.includes(s));
		expect(offenders).toEqual([]);
	});

	// ⚠️ NOT an i18n case, but it belongs to the same "the screen renders machine identifiers at a
	// human" family and this file already owns the whole-page fixture. "Most used blocks" rendered
	// `label={b.slug}` — kebab-case, in `--font-mono`, because `TopBlock` carried no name.
	//
	// ⚠️ THIS IS A VISUAL NO-OP ON THE DEMO DATABASE. `backend/src/db/seed.ts` sets `name`
	// IDENTICAL to `slug` for all twelve platform blocks, so nothing changes on screen until that
	// content is fixed. The plumbing is what ships here — hence a fixture whose name and slug
	// differ, which is the only way to assert the plumbing at all.
	it('labels a top block with its name, falling back to the slug when there is none', async () => {
		const el = await render();
		assertLoaded(el);
		const labels = () => [...el.querySelectorAll('.bar-label')].map((n) => n.textContent);
		expect(labels(), 'no block bar rendered — the assertion below would be vacuous').toHaveLength(
			1
		);
		expect(labels()[0]).toBe('Schadeclaim-triage');
		// The href stays keyed by the SLUG — that is /block-edit's lookup key, not the label.
		expect(el.querySelector('.bar-row')?.getAttribute('href')).toBe(
			'/block-edit?slug=triage-claim'
		);
	});

	it('a top block with no name still lists, labelled by its slug', async () => {
		// `getTopBlocks` derives slugs from `flow_runs.trace`, so a deleted or renamed block yields
		// a slug with no `building_blocks` row and `name: null`. An old pod mid-roll sends no `name`
		// at all. Both must render the bar, not drop it.
		const d = dto();
		d.topBlocks = [{ slug: 'rows-to-csv', name: null, category: 'data', count: 4, pct: 33 }];
		getDashboard.mockResolvedValue(d);
		const el = await render();
		assertLoaded(el);
		expect([...el.querySelectorAll('.bar-label')].map((n) => n.textContent)).toEqual([
			'rows-to-csv'
		]);
	});

	it('resolves each alert from its kind', async () => {
		const el = await render();
		assertLoaded(el);
		const titles = [...el.querySelectorAll('.alert-title')].map((n) => n.textContent);
		expect(titles).toEqual([
			'ops_alert_sandbox_error_title:3',
			'ops_alert_high_latency_title',
			'ops_alert_block_errors_title:triage-claim',
			'ops_alert_block_errors_title:rows-to-csv'
		]);
		const descs = [...el.querySelectorAll('.alert-desc')].map((n) => n.textContent);
		// The owner list is composed IN CODE — proper nouns and punctuation, no message key.
		expect(descs[0]).toBe(
			'Fatima Hassani · Email auto-categorize; Lisa de Vries; Ada Lovelace · Claims intake'
		);
		expect(descs[1]).toBe('ops_alert_high_latency_detail:2.47s,2.00s');
		expect(descs[2]).toBe('ops_alert_block_errors_detail:4,7');
		expect(descs[3]).toBe('ops_alert_block_errors_detail:2,7');
	});

	it('resolves each feed row from its kind, with the ACTOR inside the sentence', async () => {
		const el = await render();
		assertLoaded(el);
		const bodies = [...el.querySelectorAll('.feed-body')].map((n) => n.textContent);
		expect(bodies).toHaveLength(8);
		expect(bodies[0]).toBe('ops_event_block_published:Common Practice,triage-claim,1.2.0');
		// ⛔ The status word comes from the SHARED `runStatusLabel`, not a new `ops_event_*` key.
		expect(bodies[6]).toBe('ops_event_run_finished:Lisa de Vries,Weekly intake,run_status_ok');
		expect(bodies[7]).toBe('ops_event_sandbox_suspended:Fatima Hassani,Email auto-categorize');
		// ⚠️ THE TRADE-OFF, ASSERTED. The bold `.feed-actor` span is GONE on the localized branch —
		// the name is inside the interpolated sentence so ar/he can reorder it. If this ever comes
		// back, the sentence has been split again and the word-order bug is back with it.
		expect(el.querySelectorAll('.feed-body .feed-actor')).toHaveLength(0);
	});
});

// ==================================================================================================
// ⛔ THE ROLLING-DEPLOY GUARD. The two containers share a pod, but the browser reaches the API
// through the k8s SERVICE, which load-balances across old and new pods for the length of a roll —
// so a NEW frontend really does get answered by an OLD pod, whose alerts carry prose and no `kind`
// -discriminated machine fields at all.
//
// If `{#each data.attention as a, i (i)}` is changed to `(a.kind)`, the three rows key on
// 'sandbox_error' / 'high_latency' / 'block_errors' — fine here, but the query returns up to THREE
// `block_errors` rows in production, and Svelte then throws `each_key_duplicate`. `(a.slug)` keys
// all three on `undefined` and throws immediately. Neither is dev-only
// (svelte/internal/client/dom/blocks/each.js), and with no `<svelte:boundary>` anywhere in this tree
// the WHOLE page collapses — measured on /governance: 0 rows, a 326-byte body.
// ==================================================================================================
describe('⛔ an OLD backend, mid-roll', () => {
	it('survives the verbatim pre-change payload — every row present and non-blank', async () => {
		getDashboard.mockResolvedValue(legacyDto());
		const el = await render();

		// 1. The page did not collapse. The section titles live in SIBLING nodes to the two cards,
		//    so they are the honest witness that a throw did not take the screen down with it.
		assertLoaded(el);
		expect(el.querySelectorAll('.section-title').length).toBeGreaterThan(0);

		// 2. All THREE alerts and all EIGHT feed rows are present. The duplicate-key symptom is rows
		//    collapsing, so count them explicitly rather than trusting the absence of a throw.
		const alerts = [...el.querySelectorAll('.alert-title')];
		expect(alerts).toHaveLength(4);
		expect(el.querySelectorAll('.feed-body')).toHaveLength(8);

		// 3. Every row says something a reader can act on. The catalog messages cannot resolve
		//    without machine fields, so the legacy English is the CORRECT answer here — blank rows
		//    would be a different failure wearing the same green.
		const rowText = [
			...el.querySelectorAll('.alert-title'),
			...el.querySelectorAll('.alert-desc'),
			...el.querySelectorAll('.feed-body')
		].map((n) => n.textContent ?? '');
		expect(rowText.every((t) => t.trim().length > 0), 'a row rendered blank').toBe(true);
		expect(rowText.join(' | ')).toContain('3 sandboxes in error');
		expect(rowText.join(' | ')).toContain('published triage-claim v1.2.0');
		// No half-rendered message: `undefined` in a row is the interpolate-anyway bug.
		expect(rowText.join(' | ')).not.toContain('undefined');

		// 4. The legacy feed markup is intact — the bold actor span the old wire was written for.
		expect(el.querySelectorAll('.feed-body .feed-actor').length).toBe(8);

		// 5. And the rest of the screen is still localized — the fallback is scoped to the rows.
		expect(el.textContent).toContain('itdash_section_needs_attention');
	});

	it('still localizes what does NOT depend on the new fields', async () => {
		// The high-latency headline interpolates nothing, so it is translatable on both wire
		// versions; falling back there would be English for no reason.
		getDashboard.mockResolvedValue(legacyDto());
		const el = await render();
		assertLoaded(el);
		expect([...el.querySelectorAll('.alert-title')].map((n) => n.textContent)).toContain(
			'ops_alert_high_latency_title'
		);
	});
});
