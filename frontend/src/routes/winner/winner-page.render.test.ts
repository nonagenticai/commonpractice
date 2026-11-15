// @vitest-environment jsdom
//
// src/routes/winner/winner-page.render.test.ts — what /winner actually renders.
//
// ⛔ THE DEFECTS, as the page was about to announce the product's first real weekly winner:
//
//   COMMON PRACTICE ·          ← `winner_hero_eyebrow({ week: data.week ?? '' })`; the fallback
//                                 paths never set `week`, so the separator dangled with nothing
//                                 after it.
//   0  stemmen ontvangen       ← and the "total votes cast" TILE VANISHED, because
//                                 `{#if data.stats.totalVotesCast}` reads a genuine 0 as absence.
//                                 The hero silently dropped from 4 tiles to 3.
//   De week in cijfers         ← a titled card over an EMPTY <ul>, for the same reason, ×4.
//   ✓ Won vote  ● Code review  ← backend-authored ENGLISH rendered verbatim in a Dutch UI.
//   "…staat nu in hardening ." ← the raw enum, plus a stray space from the nl catalog.
//
// The page runs `onMount(load)`, so the API client is mocked and the fixture IS the payload.
// Assertions are on MESSAGE TOKENS, never on English copy — the messages module returns each
// key's own name, so a reworded translation cannot red these and a resurrected English label
// cannot pass them.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { WeeklyWinner } from '$lib/types/marketplace';

vi.mock('$lib/paraglide/messages', () => ({
	winner_loading: () => 'WINNER_LOADING',
	winner_hero_eyebrow: ({ week }: { week: string }) => `EYEBROW_WITH_WEEK:${week}`,
	winner_hero_eyebrow_no_week: () => 'EYEBROW_NO_WEEK',
	// The eyebrow names the period through `periodKeyName` (challenge-state.ts), never the raw key.
	challenge_period_week: ({ week, year }: { week: number; year: number }) => `PERIOD_WEEK:${week},${year}`,
	challenge_period_quarter: ({ quarter, year }: { quarter: number; year: number }) => `PERIOD_Q:${quarter},${year}`,
	winner_hero_title: ({ name }: { name: string }) => `HERO_TITLE:${name}`,
	winner_hero_rank_note: ({ rank }: { rank: number }) => `HERO_RANK_NOTE:${rank}`,
	winner_solution_to_pre: () => 'SOLUTION_TO_PRE',
	winner_solution_to_by: ({ submitter }: { submitter: string }) => `SOLUTION_TO_BY:${submitter}`,
	winner_stat_votes_received: () => 'STAT_VOTES_RECEIVED',
	winner_stat_total_votes: () => 'STAT_TOTAL_VOTES',
	winner_stat_demo_time: () => 'STAT_DEMO_TIME',
	winner_stat_blocks_used: () => 'STAT_BLOCKS_USED',
	winner_view_solution: () => 'VIEW_SOLUTION',
	winner_timeline_title: () => 'TIMELINE_TITLE',
	winner_timeline_note_pre: () => 'NOTE_PRE ',
	winner_timeline_note_after: () => '. NOTE_AFTER',
	winner_step_hardening: ({ day, ofDays }: { day: number; ofDays: number }) => `STEP_HARDENING:${day}/${ofDays}`,
	winner_step_staging: ({ pct }: { pct: number }) => `STEP_STAGING:${pct}`,
	winner_step_live: () => 'STEP_LIVE',
	winner_step_in_progress: () => 'STEP_IN_PROGRESS',
	winner_mentions_title: () => 'MENTIONS_TITLE',
	winner_mentions_empty: () => 'MENTIONS_EMPTY',
	winner_numbers_title: () => 'NUMBERS_TITLE',
	winner_numbers_empty: () => 'NUMBERS_EMPTY',
	winner_num_total_votes: () => 'NUM_TOTAL_VOTES',
	winner_num_solutions_submitted: () => 'NUM_SOLUTIONS_SUBMITTED',
	winner_none: () => 'WINNER_NONE',
	error_load_failed: () => 'ERROR_LOAD_FAILED',
	// `demoDuration` (lib/utils/format.ts) resolves its unit through THIS module, so the demo-time
	// tile renders one of these three. They echo their argument: an assertion on 'DUR_MS:0' proves
	// the page passed the real figure through, which a hard-coded 'DUR' could not.
	demo_dur_ms: ({ count }: { count: number }) => `DUR_MS:${count}`,
	demo_dur_sec: ({ count }: { count: string }) => `DUR_SEC:${count}`,
	demo_dur_min_sec: ({ mins, secs }: { mins: number; secs: number }) => `DUR_MIN_SEC:${mins}:${secs}`,
	// stage-label.ts pulls from the same module — these are the four sites under test.
	pipeline_stage_won: () => 'M_WON',
	pipeline_stage_review: () => 'M_REVIEW',
	pipeline_stage_hardening: () => 'M_HARDENING',
	pipeline_stage_staging: () => 'M_STAGING',
	pipeline_stage_production: () => 'M_PRODUCTION'
}));

const { winner } = vi.hoisted(() => ({ winner: vi.fn() }));
// ⛔ ALIAS module ids, never relative ones — a relative mock id resolves to a different module
// record than the one the component imports and silently does nothing.
vi.mock('$lib/api/marketplace', () => ({ marketplaceApi: { winner, home: vi.fn() } }));
vi.mock('$lib/api/error-message', () => ({ errorText: (_e: unknown, f: string) => f }));
vi.mock('$lib/i18n/reload-on-locale.svelte', () => ({ reloadOnLocaleChange: () => {} }));

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
	vi.clearAllMocks();
});

async function render(payload: WeeklyWinner) {
	winner.mockResolvedValue(payload);
	const { default: WinnerPage } = await import('./+page.svelte');
	app = mount(WinnerPage, { target: host, props: {} });
	// `onMount` fires an async load. Drain the macro- AND micro-task queues, then flush Svelte's
	// effects, until the loading notice is gone — a fixed number of `await Promise.resolve()`
	// silently leaves the page on `winner_loading` and every assertion below becomes vacuous.
	for (let i = 0; i < 20 && host.textContent?.includes('WINNER_LOADING') !== false; i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
	expect(host.textContent, 'the page never left its loading state — the fixture did not land').not.toContain(
		'WINNER_LOADING'
	);
	return host;
}

/** ⚠️ `label` is set to the LITERAL English the backend still sends. If the page ever reads it —
 *  directly, or through a `?? step.label` fallback — these strings appear in the DOM and the
 *  timeline assertions fail. That is the point of spelling them out. */
const STEPS: WeeklyWinner['pipeline'] = {
	stage: 'hardening',
	rolloutPct: 0,
	live: false,
	progress: { day: 2, ofDays: 5 },
	steps: [
		{ key: 'won', label: 'Won vote', state: 'done' },
		{ key: 'review', label: 'Code review', state: 'done' },
		{ key: 'hardening', label: 'Hardening', state: 'active' },
		{ key: 'staging', label: 'Staging', state: '' },
		{ key: 'production', label: 'Production', state: '' }
	]
};

function payload(over: Partial<WeeklyWinner> = {}): WeeklyWinner {
	return {
		week: '2026-W32',
		announcedAt: '2026-08-10T00:00:00.000Z',
		stats: { totalVotesCast: 0, solutionsSubmitted: 1 },
		pipeline: null,
		winner: {
			// Rank 1 by default: the ordinary case, and the one that must render NO extra note.
			rank: 1,
			solution: {
				id: 'sol-1',
				title: 'Schadeformulier-samenvatter',
				votesCount: 0,
				// ⛔ `demoMs: 0` — FIXTURE CHANGED, ASSERTION UNTOUCHED. The 4-tile assertion below is
				// about `totalVotesCast: 0` keeping ITS tile; dropping it to 3 to accommodate this
				// change would silently delete the 0-is-data guard this whole file exists for. So the
				// fourth tile stays a tile, and it is the demo-time one, present because 0 ms is a
				// measured answer. The slot used to hold BUILD TIME with `buildTimeMinutes: 41`, and
				// that number was fiction on this page: the column is NULL for every solution created
				// through Build → Submit, so the hero really rendered '—'. The `demoMs: null` case is
				// covered by its own test at the bottom of this file.
				demoMs: 0,
				blocksUsed: ['a', 'b'],
				flowId: null,
				author: { name: 'FR Test', initials: 'FT' }
			},
			challenge: { id: 'ch-1', code: 'CH-284', title: 'Nederlandse uitdaging', submitter: 'Sam' }
		},
		honorableMentions: [],
		...over
	} as WeeklyWinner;
}

// ── 1b: a real ZERO is data ──────────────────────────────────────────────────────────────────

describe('a week in which no votes were cast still reports its figures', () => {
	it('THE PROD CASE — 0 total votes keeps the 4th hero tile AND renders both numbers rows', async () => {
		const el = await render(payload({ stats: { totalVotesCast: 0, solutionsSubmitted: 1 } }));

		// The hero keeps four tiles: votes received, total votes cast, demo time, blocks used.
		const tiles = el.querySelectorAll('.winner-stats > div');
		expect(tiles).toHaveLength(4);
		expect(el.textContent).toContain('STAT_TOTAL_VOTES');

		// …and "The week in numbers" lists both rows rather than rendering a heading over nothing.
		const rows = [...el.querySelectorAll('.numbers li')].map((li) => li.textContent ?? '');
		expect(rows).toHaveLength(2);
		expect(rows.join('|')).toContain('NUM_TOTAL_VOTES');
		expect(rows.join('|')).toContain('NUM_SOLUTIONS_SUBMITTED');
		// The zero itself is on the page, not swallowed.
		expect(el.querySelector('.numbers')!.textContent).toContain('0');
		expect(el.textContent).not.toContain('NUMBERS_EMPTY');
	});

	it('a stats object with NO figures renders the empty state INSIDE the card, not a hidden card', async () => {
		const el = await render(payload({ stats: {} }));
		// The card is still there — it shares a two-column grid with Honorable mentions and
		// dropping it collapses the layout asymmetrically.
		expect(el.textContent).toContain('NUMBERS_TITLE');
		expect(el.querySelectorAll('.grid > .card')).toHaveLength(2);
		// …and it explains itself, in the same `.empty` class the sibling mentions card uses.
		const empty = el.querySelectorAll('.card .empty');
		expect([...empty].map((e) => e.textContent)).toContain('NUMBERS_EMPTY');
		expect(el.querySelector('.numbers')).toBeNull();
	});

	it('renders only the figures it was given — absent ones are absent, present zeroes are rows', async () => {
		const el = await render(payload({ stats: { solutionsSubmitted: 0 } }));
		const rows = [...el.querySelectorAll('.numbers li')].map((li) => li.textContent ?? '');
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain('NUM_SOLUTIONS_SUBMITTED');
		// ⛔ Nothing is invented to fill the card: no first-time-builders, no cross-domain row.
		expect(el.textContent).not.toContain('NUM_FIRST_TIME_BUILDERS');
		expect(el.textContent).not.toContain('NUM_CROSS_DOMAIN');
		// The 3-tile hero is correct HERE: totalVotesCast really is absent.
		expect(el.querySelectorAll('.winner-stats > div')).toHaveLength(3);
	});
});

// ── WS-2: the hero never renders an em dash for a figure it does not have ────────────────────

describe('an unmeasured demo is an ABSENT tile, never a rendered em dash', () => {
	it('THE DEFECT — `demoMs: null` drops the tile and puts no "—" in the hero', async () => {
		const el = await render(
			payload({
				winner: { ...payload().winner, solution: { ...payload().winner!.solution, demoMs: null } }
			} as Partial<WeeklyWinner>)
		);

		// ⛔ THE ASSERTION THAT PINS IT. This slot used to render `buildTime(null)`, a helper whose
		// null branch returned the literal '—', UNCONDITIONALLY — so the demo's payoff screen led
		// with an em dash where its headline figure belongs, on every solution a real person had
		// ever submitted. Reverting to an unconditional tile puts the dash back and reds this line.
		expect(el.querySelector('.winner-stats')!.textContent).not.toContain('—');
		expect(el.textContent).not.toContain('STAT_DEMO_TIME');

		// Three tiles: votes received, total votes cast (0 — still data), blocks used.
		expect(el.querySelectorAll('.winner-stats > div')).toHaveLength(3);
	});

	it('a measured ZERO is data: the tile renders, with the figure, formatted', async () => {
		// The other half of the `!= null` rule, and the reason this cannot be a truthiness check.
		// `demoMs: 0` is the base fixture, so this is the default hero.
		const el = await render(payload());
		expect(el.querySelector('.winner-stats')!.textContent).toContain('STAT_DEMO_TIME');
		// The real value reached the formatter — not a placeholder, not a dash.
		expect(el.querySelector('.winner-stats')!.textContent).toContain('DUR_MS:0');
		expect(el.querySelector('.winner-stats')!.textContent).not.toContain('—');
	});

	it('a sub-second duration is rendered in seconds, from the value the server sent', async () => {
		const el = await render(
			payload({
				winner: { ...payload().winner, solution: { ...payload().winner!.solution, demoMs: 3400 } }
			} as Partial<WeeklyWinner>)
		);
		// 3400 ms → "3.4s". ⛔ NOT "0m": routing this through `duration()` (the /pipeline helper,
		// which floors at minutes) is what this figure's own formatter exists to prevent.
		expect(el.querySelector('.winner-stats')!.textContent).toContain('DUR_SEC:3.4');
	});
});

// ── 1b: the eyebrow ──────────────────────────────────────────────────────────────────────────

describe('the hero eyebrow never prints a dangling separator', () => {
	it('with a week, interpolates its NAME — not the raw "2026-W32" key', async () => {
		const el = await render(payload({ week: '2026-W32' }));
		expect(el.querySelector('.hero-eyebrow')!.textContent!.trim()).toBe('EYEBROW_WITH_WEEK:PERIOD_WEEK:32,2026');
	});

	it('with NO week, uses the brand-only message instead of interpolating an empty string', async () => {
		const el = await render(payload({ week: null }));
		const eyebrow = el.querySelector('.hero-eyebrow')!.textContent!.trim();
		expect(eyebrow).toBe('EYEBROW_NO_WEEK');
		// The old code rendered `EYEBROW_WITH_WEEK:` — the separator with nothing after it.
		expect(eyebrow).not.toContain('EYEBROW_WITH_WEEK');
	});
});

// ── 1c: one stage vocabulary ─────────────────────────────────────────────────────────────────

describe('the production timeline speaks the reader’s language, not the backend’s', () => {
	it('renders the STAGE MESSAGE for every step, never the English `label` the backend sends', async () => {
		const el = await render(payload({ pipeline: STEPS }));
		const labels = [...el.querySelectorAll('.step-label')].map((n) => n.textContent);
		expect(labels).toEqual(['M_WON', 'M_REVIEW', 'M_HARDENING', 'M_STAGING', 'M_PRODUCTION']);

		// The fixture's `label` fields are the literal English. If ANY of them reaches the DOM —
		// by reverting to `{step.label}`, or by sneaking in a `?? step.label` fallback — this
		// fails. `M_REVIEW` and the literal `Code review` are deliberately different strings.
		for (const english of ['Won vote', 'Code review', 'Hardening', 'Staging', 'Production']) {
			expect(el.textContent, `the backend's English "${english}" reached the page`).not.toContain(english);
		}
	});

	it('the "this card sits in X" sentence names the stage in words, not the raw enum', async () => {
		const el = await render(payload({ pipeline: STEPS }));
		const note = el.querySelector('.seeded-note')!;
		expect(note.querySelector('b')!.textContent).toBe('M_HARDENING');
		// The raw enum used to be printed here verbatim.
		expect(note.textContent).not.toContain('hardening');
		// …and the sentence has no stray space before its full stop (the nl/de/pl catalog fix).
		expect(note.textContent).toBe('NOTE_PRE M_HARDENING. NOTE_AFTER');
		expect(note.textContent).not.toContain(' .');
	});

	it('the active step still carries its detail — the vocabulary change did not break stepDetail', async () => {
		const el = await render(payload({ pipeline: STEPS }));
		const details = [...el.querySelectorAll('.step-detail')].map((n) => n.textContent);
		expect(details[2]).toBe('STEP_HARDENING:2/5');
		expect(details.filter(Boolean)).toHaveLength(1);
	});
});

// ── WS-2: the hero says which position the winner actually held ──────────────────────────────
//
// ⛔ THE DEFECT THIS PAIRS WITH. `/api/winner` numbered the runners-up `i + 2`, i.e. it asserted
// the winner was rank 1 without measuring. It is not: two of the three winner sources are
// vote-independent, so prod rendered a 2-VOTE winner above a 233-VOTE "#2". The backend now sends
// the measured `rank`; with true positions underneath, a mention CAN legitimately read "#1", and
// the hero has to account for that instead of leaving the reader with a contradiction.

describe('the hero declares the winner’s real position on the vote', () => {
	it('rank 1 — nothing extra. The title already says it.', async () => {
		const el = await render(payload());
		expect(el.querySelector('.hero-rank-note')).toBeNull();
		expect(el.textContent).not.toContain('HERO_RANK_NOTE');
		// The title is untouched by all of this: it did win the week.
		expect(el.querySelector('h1')!.textContent).toContain('HERO_TITLE:');
	});

	it('THE PROD ROW — rank 4 renders the note, carrying the measured number', async () => {
		const el = await render(
			payload({
				winner: { ...payload().winner!, rank: 4 },
				honorableMentions: [
					{ rank: 1, id: 'm1', title: 'De echte koploper', votesCount: 233, blocksUsed: [], author: { name: 'A', initials: 'A' } }
				]
			} as Partial<WeeklyWinner>)
		);
		// The real figure reaches the message — an assertion on a bare 'HERO_RANK_NOTE' would pass
		// on a hard-coded 2 and prove nothing.
		expect(el.querySelector('.hero-rank-note')!.textContent).toBe('HERO_RANK_NOTE:4');
		// …and the mention below it is allowed to be #1, which is the whole point.
		expect(el.querySelector('.m-rank')!.textContent).toBe('#1');
	});

	it('rank null — NOTHING. A winner with no position on this week’s board is not guessed at 1.', async () => {
		const el = await render(payload({ winner: { ...payload().winner!, rank: null } } as Partial<WeeklyWinner>));
		expect(el.querySelector('.hero-rank-note')).toBeNull();
		expect(el.textContent).not.toContain('HERO_RANK_NOTE');
		// No fabricated placeholder in its place either — same rule as the demo-time tile.
		expect(el.querySelector('.hero')!.textContent).not.toContain('—');
	});
});
