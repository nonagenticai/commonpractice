<script lang="ts">
	// The weekly cadence strip (home screen). Reflects the demo's fixed Mon–Fri rhythm.
	// When a live cycle is passed (Phase 2-E) it drives the highlight + a countdown from the real
	// phase instead of a static "today", and WHICH cards a phase covers is computed from that
	// cycle's own boundary instants by `phaseDays` — see cycle-phase-days.ts for the hand-written
	// table that used to sit here, why it disagreed with the engine, and why a corrected table would
	// have been the same mistake. With NO cycle it falls back to the reader's REAL weekday — see
	// `cadence-day.ts` for why this used to be the literal string 'WED' and what a weekend does.
	import * as m from '$lib/paraglide/messages';
	import type { CycleState } from '$lib/types/cycle';
	import { cadenceDayKey, cadenceDayLabel, type CadenceDayKey } from './cadence-day';
	import { cardForUtcInstant, phaseDays, votingCloseCard } from './cycle-phase-days';
	import { dayMonth, weekdayTime } from '$lib/utils/format';
	// `locale.current` is the rune the whole app's m.*() calls are bound to (stores/locale.svelte
	// rebinds paraglide's getLocale onto it). Reading it here is what makes the Intl-formatted day
	// names re-render on a locale switch, exactly like the message-backed titles beside them.
	import { locale } from '$lib/stores/locale.svelte';

	const mm = m as unknown as Record<string, (i?: Record<string, unknown>) => string>;

	// `today` stays a prop so a caller (and a test) can pin the day, but its DEFAULT is now the
	// real weekday rather than a hard-coded 'WED' that no call site ever overrode. `null` = a
	// weekend: a valid value meaning "none of the five cards is today", not a missing one.
	// `kind` = the effective cadence when there is no cycle row. A month/quarter/year cadence with no row
	// (its period has not opened yet) has no Mon–Fri rhythm: it renders a neutral line, never the
	// weekly day cards. Week, or absent (older backend), keeps the five cards.
	let {
		today: todayProp = undefined,
		cycle = null,
		kind = undefined
	}: { today?: string | null; cycle?: CycleState | null; kind?: string } = $props();
	// ⛔ WITH A LIVE CYCLE, "TODAY" IS THE UTC DAY — THE SAME GRID THE PHASE CARDS ARE DRAWN ON.
	// `phaseDays`/`votingCloseCard` place every card by `getUTCDay()` (the engine's boundaries are
	// UTC). The marker used to be the reader's LOCAL weekday, so a New York reader at Thu 21:00 (Fri
	// 01:00 UTC) saw THU marked "today" while FRI was the lit phase card and THU's "Closes Thu 20:00"
	// was already past — three contradictory claims on one strip. Times still render in the reader's
	// timezone; only WHICH CARD is today follows the grid. With no cycle there is no UTC grid on
	// screen, so the reader's own weekday stays (cadence-day.ts).
	const today = $derived(
		todayProp !== undefined ? todayProp : cycle ? cardForUtcInstant(Date.now()) : cadenceDayKey()
	);
	const waitingLongPeriod = $derived(!cycle && (kind === 'month' || kind === 'quarter' || kind === 'year'));
	// `k` is the STABLE ENGLISH IDENTIFIER — it is what `activeDays` (and therefore `phaseDays`)
	// membership-tests, and is never shown; `cadenceDayLabel(k, locale)` is what the reader sees.
	// tKey/sKey resolve title + subtitle.
	//
	// ⚠️ THE TITLES ARE ENGINE CLAIMS AND MOVED WITH THE MAPPING. Two of them named an activity on a
	// day the engine does not run it, and remapping the highlight alone would have lit those cards
	// under that copy: THU said "Vote on solutions" while solution voting does not open until
	// `voting_ends_at` = Fri 00:00 UTC, and FRI said "Guest talk + winner" while the winner is
	// announced at `closes_at` = Mon 00:00 UTC. FRI now names the phase it actually opens, and the
	// winner claim is left to `cycle_phase_closed` in the header above, which renders exactly when
	// the engine says the week is closed.
	//
	// ⛔ AND THU NAMES NO BOUNDARY AT ALL — THE FIRST ATTEMPT AT IT WAS A SECOND FALSE CLAIM. THU
	// was briefly "Challenge voting closes", which is not a day-of-the-week statement but an
	// INSTANT, and the engine's instant is `voting_ends_at` = FRIDAY 00:00 UTC. Sitting above the
	// exempt "Closes 18:00" subtitle it read as "challenge voting closes Thursday 18:00": six hours
	// early, and a different calendar day for every reader west of UTC. It is now "Last day of
	// challenge voting" — the true thing about Thursday, which is that it is the last UTC day inside
	// `[weekStart, voting_ends_at)`, said without naming a closing instant. The boundary belongs to
	// FRI, where it already is ("solutions open" is the same instant from the other side). Only the
	// card the boundary LANDS on may say a phase closes; the rule is asserted from the engine's own
	// numbers in cadence-strip.phase-days.render.test.ts, not from a day name typed into a test.
	//
	// ⚠️ /docs STILL CARRIES THE THURSDAY CLAIM AS OF THIS COMMIT, AND THAT IS NOT THIS BRANCH'S TO
	// FIX. `docs_cadence_thu_day`/`_text` read "Thursday 18:00 — challenge + solution voting closes"
	// (routes/docs/+page.svelte:104) — the same false instant, on another surface, in all eight
	// locales. A separate workstream (`docs/cp-cadence-and-parked-alerts-truth`) replaces it with
	// "Friday 00:00 UTC"; that key does NOT exist yet and nothing here may cite it as if it did. The
	// reason this matters HERE is the failure mode of the alternative: had this card kept a closing
	// instant of its own, the two branches would have shipped two different Thursdays/Fridays and
	// /docs and the home strip would state contradictory boundaries. Naming no instant is correct
	// against the engine whichever order the two land in.
	//
	// The remaining `mkt_cadence_*_s` subtitles ("10:00 – 11:00", "14:30 · CTO café") are the
	// company's standing ritual, NOT per-row deadlines, and are exempt on purpose —
	// $lib/challenges/vote-surface-copy.test.ts states that exemption in writing. "Closes 18:00" on
	// MON/THU was NOT a ritual but a false deadline (voting closes Fri 00:00 UTC); it is gone, and the
	// close instant comes off the cycle row instead (`closeLabel` below).
	//
	// ⛔ WED HAS NO sKey. Its subtitle was the catalog literal "in 2 hours" / "over 2 uur" — the
	// only one of the five that claimed to be relative to NOW, and the only one nothing computed.
	// It was therefore false at every moment except one morning a week, on the home screen, on the
	// card the highlight points at. There is nothing true to put in its place: the strip is told
	// the week's PHASE boundaries (votingEndsAt/closesAt), never when Wednesday's one-hour session
	// starts or ends, so any interval printed here would be a second invention. The real countdown
	// the component CAN compute is already on screen, once, in the `.cycle-phase` header above.
	const DAYS: { k: CadenceDayKey; tKey: string; sKey: string | null; tone: string }[] = [
		{ k: 'MON', tKey: 'mkt_cadence_mon_t', sKey: null, tone: 'teal' },
		{ k: 'TUE', tKey: 'mkt_cadence_tue_t', sKey: 'mkt_cadence_tue_s', tone: 'coral' },
		{ k: 'WED', tKey: 'mkt_cadence_wed_t', sKey: null, tone: 'coral' },
		{ k: 'THU', tKey: 'mkt_cadence_thu_t', sKey: null, tone: 'coral' },
		{ k: 'FRI', tKey: 'mkt_cadence_fri_t', sKey: 'mkt_cadence_fri_s', tone: 'amber' }
	];

	// The set of highlighted day keys: the live phase's own days when a cycle exists, else today —
	// and on a weekend (`today === null`) NOTHING is highlighted, rather than an `[undefined]` that
	// would silently never match anyway. During `closed` `phaseDays` returns `[]` on purpose: the
	// week is over, none of the five activities is running, and the `.cycle-phase` header below
	// already says so. See cycle-phase-days.ts for why lighting MON there contradicted itself.
	//
	// ⛔ NO TABLE HERE, DELIBERATELY. `phaseDays` reads the cycle's `week` + `votingEndsAt` +
	// `closesAt` — the values `boundariesFor()` wrote FROM `config.cycle.votingDays/solutionDays` —
	// so the cadence is read from the payload rather than restated in this file. A literal day list
	// on this line is a copy of another process's environment variable and was wrong by three days.
	const activeDays = $derived(cycle ? phaseDays(cycle) : today ? [today] : []);

	// ⛔ "Closes 18:00" WAS A CATALOG LITERAL ON MON AND THU, AND IT WAS FALSE: voting closes at the
	// cycle's `votingEndsAt` (Fri 00:00 UTC), Monday closes nothing. The subtitle is now that instant,
	// in the reader's timezone and with its weekday, on the last card of the voting window — and no
	// subtitle at all without a cycle, because then nothing on the wire says when anything closes.
	const closeCard = $derived(cycle ? votingCloseCard(cycle) : null);
	const closeLabel = $derived(
		cycle && closeCard
			? m.mkt_cadence_closes_at({ time: weekdayTime(cycle.votingEndsAt, locale.current) })
			: ''
	);

	/**
	 * A coarse remaining-time to the phase boundary, in the reader's own units.
	 *
	 * ⛔ THE UNIT USED TO BE WELDED IN ENGLISH: `` `${Math.floor(hours / 24)}d` `` /
	 * `` `${Math.max(1, hours)}h` ``. So the home screen's countdown — the first sentence a Dutch
	 * reader meets on the first screen — read "sluit over 14h", with a `u` sitting in
	 * `pipeline_dur_hour` in all eight catalogs the whole time. `format.ts` documents this exact
	 * template-literal pattern as forbidden, and the old comment on this line claimed the result was
	 * "direction-neutral, RTL-safe" — which was true only because the container that renders it pins
	 * `dir="ltr"`. Masking the bidi half does not translate the unit.
	 *
	 * ⛔ THE KEYS ARE REUSED; `duration()` IS NOT, AND THAT IS DELIBERATE. `$lib/utils/format`'s
	 * `duration()` reaches the same three keys but with a different POLICY: it rounds rather than
	 * floors, buckets minutes below an hour, and switches to days at 48h rather than 24h. Calling it
	 * here would silently change what the countdown says — a 30-hour remainder becomes "30u" instead
	 * of "1d", a 20-minute one "20m" instead of "1u" — which is a product change wearing a
	 * translation fix's clothes. The units are shared vocabulary; the bucketing is this screen's.
	 *
	 * ⚠️ `count` STAYS RAW — no `num()`. These are `{count}u` / `{count}d` plain strings, and the
	 * figure is a countdown to a cycle boundary: single digits, days at most. Grouping it could only
	 * ever put a separator into a number that never needs one.
	 */
	function remaining(target: string): string {
		const ms = new Date(target).getTime() - Date.now();
		if (ms <= 0) return '—';
		const hours = Math.floor(ms / 3_600_000);
		return hours >= 24
			? m.pipeline_dur_day({ count: Math.floor(hours / 24) })
			: m.pipeline_dur_hour({ count: Math.max(1, hours) });
	}

	const phaseLabel = $derived(
		cycle
			? cycle.phase === 'voting'
				? m.cycle_phase_voting()
				: cycle.phase === 'solution_phase'
					? m.cycle_phase_solution()
					: m.cycle_phase_closed()
			: ''
	);

	// Countdown target: voting→votingEndsAt, solution_phase→closesAt, closed→none.
	// 0107: a MONTH, QUARTER or YEAR period has no Mon–Fri rhythm to draw, so it renders as one phase bar:
	// voting [periodStart → votingEndsAt], building [votingEndsAt → closesAt], and a marker at now.
	// A week (and an older backend that sends no `periodKind`) keeps the five day cards above.
	const isLongPeriod = $derived(!!cycle && (cycle.periodKind === 'month' || cycle.periodKind === 'quarter' || cycle.periodKind === 'year'));
	const bar = $derived.by(() => {
		if (!cycle || !isLongPeriod || !cycle.periodStart) return null;
		const start = new Date(cycle.periodStart).getTime();
		const end = new Date(cycle.closesAt).getTime();
		const total = end - start;
		if (!(total > 0)) return null;
		const pct = (instantMs: number) => Math.min(100, Math.max(0, ((instantMs - start) / total) * 100));
		return {
			votingPct: pct(new Date(cycle.votingEndsAt).getTime()),
			nowPct: pct(Date.now()),
			// The period's first and LAST day. Both are UTC dates: a period starts 00:00 UTC, and
			// `closesAt` is the NEXT period's first instant, so its last day is the day before.
			startLabel: dayMonth(start, locale.current, 'UTC'),
			endLabel: dayMonth(end - 1, locale.current, 'UTC')
		};
	});

	const countdown = $derived(
		cycle && cycle.phase !== 'closed'
			? m.cycle_countdown_pre({
					time: remaining(cycle.phase === 'voting' ? cycle.votingEndsAt : cycle.closesAt)
				})
			: ''
	);
</script>

{#if cycle}
	<div class="cycle-phase" dir="ltr">
		<span class="cp-dot" class:closed={cycle.phase === 'closed'}></span>
		<span class="cp-label">{phaseLabel}</span>
		{#if countdown}<span class="cp-count">· {countdown}</span>{/if}
	</div>
{/if}

{#if waitingLongPeriod}
	<p class="period-waiting" data-testid="cadence-period-waiting">{m.cadence_waiting()}</p>
{:else if bar}
	<div class="period-bar" data-testid="cadence-period-bar">
		<div class="pb-track" dir="ltr">
			<div class="pb-seg voting" style="width: {bar.votingPct}%"></div>
			<div class="pb-seg building" style="width: {100 - bar.votingPct}%"></div>
			<div class="pb-now" style="left: {bar.nowPct}%"></div>
		</div>
		<div class="pb-dates" dir="ltr">
			<span data-testid="period-bar-start">{bar.startLabel}</span>
			<span data-testid="period-bar-end">{bar.endLabel}</span>
		</div>
		<div class="pb-legend">
			<span class="pb-key voting">{m.cadence_bar_voting()}</span>
			<span class="pb-key building">{m.cadence_bar_building()}</span>
		</div>
	</div>
{:else}
<div class="cadence">
	{#each DAYS as d (d.k)}
		<!-- `today` (class) = the PHASE highlight; `is-today` = today's card (UTC grid under a live cycle, see `today`). They are two
		     facts and render differently: under a live cycle the highlight follows the phase, and the
		     reader still needs to see which of the five cards is today. -->
		<div
			class="day {d.tone}"
			class:today={activeDays.includes(d.k)}
			class:is-today={d.k === today}
			aria-current={d.k === today ? 'date' : undefined}
		>
			<!-- The membership test above compares `d.k`; only this line localizes it. -->
			<div class="dk">{cadenceDayLabel(d.k, locale.current)}{#if d.k === today} {m.mkt_cadence_today()}{/if}</div>
			<div class="dt">{mm[d.tKey]()}</div>
			<!-- Kept unconditionally (empty for WED) so the five cards keep one baseline grid.
			     `.ds` carries a min-height for the same reason: the grid row stretches, but an empty
			     div is 0px tall, so WED would show a visible hole where its four siblings show a
			     time. Reserving the line is the point of rendering it at all. -->
			<div class="ds">{d.k === closeCard ? closeLabel : d.sKey ? mm[d.sKey]() : ''}</div>
		</div>
	{/each}
</div>
{/if}

<style>
	.cycle-phase {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 12px;
		font-size: 12.5px;
		font-weight: 600;
		color: var(--c-ink);
	}
	.cp-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--c-coral);
		box-shadow: 0 0 0 3px var(--c-coral-pale);
	}
	.cp-dot.closed {
		background: var(--c-teal);
		box-shadow: 0 0 0 3px var(--c-teal-light);
	}
	.cp-count {
		color: var(--c-muted);
		font-weight: 500;
	}
	.cadence {
		display: grid;
		grid-template-columns: repeat(5, 1fr);
		gap: 12px;
	}
	.day {
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		padding: 14px;
	}
	.day.today {
		background: var(--c-coral-pale);
		border-color: var(--c-coral-light);
	}
	/* The reader's own weekday: an outline, so it stays visible on top of (or apart from) the phase
	   highlight's fill. */
	.day.is-today {
		box-shadow: inset 0 0 0 2px var(--c-midnight);
	}
	.dk {
		font-size: 10.5px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		font-weight: 700;
		color: var(--c-muted);
	}
	.day.teal .dk {
		color: var(--c-teal-dark);
	}
	.day.coral .dk,
	.day.today .dk {
		color: var(--c-coral-dark);
	}
	.day.amber .dk {
		color: #92400e;
	}
	.dt {
		font-size: 13px;
		font-weight: 600;
		color: var(--c-ink);
		margin: 6px 0 2px;
	}
	.ds {
		min-height: 1.15em;
		font-size: 11.5px;
		color: var(--c-muted);
	}
	.period-waiting {
		margin: 0;
		font-size: 13px;
		color: var(--c-muted);
	}
	.period-bar {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.pb-track {
		position: relative;
		display: flex;
		height: 12px;
		border-radius: 6px;
		overflow: hidden;
		border: 1px solid var(--c-border);
	}
	/* ⛔ WAS `--c-coral-pale` (#FFF7ED on a white card: contrast 1.04, i.e. invisible). The voting
	   segment and its swatch must clear the 3:1 non-text contrast floor against the card —
	   cadence-strip.period-bar.render.test.ts computes it from tokens.css. */
	.pb-seg.voting {
		background: var(--c-coral);
	}
	.pb-seg.building {
		background: var(--c-teal-light);
	}
	.pb-now {
		position: absolute;
		top: -2px;
		bottom: -2px;
		width: 2px;
		margin-left: -1px;
		background: var(--c-ink);
	}
	.pb-dates {
		display: flex;
		justify-content: space-between;
		margin-top: -4px;
		font-size: 11.5px;
		color: var(--c-muted);
	}
	.pb-legend {
		display: flex;
		gap: 16px;
		font-size: 11.5px;
		color: var(--c-muted);
	}
	.pb-key::before {
		content: '';
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 2px;
		margin-inline-end: 6px;
	}
	.pb-key.voting::before {
		background: var(--c-coral);
		border: 1px solid var(--c-coral-dark);
	}
	.pb-key.building::before {
		background: var(--c-teal-light);
		border: 1px solid var(--c-teal);
	}
	@media (max-width: 860px) {
		.cadence {
			grid-template-columns: repeat(2, 1fr);
		}
	}
</style>
