// @vitest-environment jsdom
//
// src/lib/components/marketplace/cadence-strip.countdown-unit.render.test.ts — the home screen's
// cycle countdown, in DUTCH.
//
// ⛔ THE DEFECT. `remaining()` built its unit in a template literal:
//
//     return hours >= 24 ? `${Math.floor(hours / 24)}d` : `${Math.max(1, hours)}h`;
//
// So the FIRST sentence a Dutch reader meets on the FIRST screen read "sluit over 14h" — with a `u`
// sitting in `pipeline_dur_hour` in all eight catalogs the whole time. `format.ts` documents this
// exact template-literal pattern as forbidden, and `duration()` has reached those keys for the
// pipeline cards since they were minted.
//
// ⚠️ THE OLD COMMENT ON THAT LINE CLAIMED THE RESULT WAS "direction-neutral, RTL-safe", which was
// true only because the element that renders it pins `dir="ltr"`. Masking the bidi half does not
// translate the unit — and the `dir="ltr"` is there for the phase row's own reasons, not this one's.
//
// ⛔ THE KEYS ARE REUSED, `duration()` IS NOT — and the last case here is why. `$lib/utils/format`'s
// `duration()` reaches the same three keys with a DIFFERENT policy: it rounds rather than floors,
// buckets minutes below an hour, and switches to days at 48h rather than 24h. Calling it would
// silently restate the countdown (a 30-hour remainder as "30u" instead of "1d"), which is a product
// change wearing a translation fix's clothes. The bucketing is asserted so nobody "simplifies" it
// into `duration()` later.
//
// ⚠️ ASSERTS DUTCH WORDS, NOT KEY NAMES — the reader-visible defect IS an English unit, and a
// key-name stub renders the broken and the fixed versions as the same key.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '$lib/test/source-scan';
import type { CycleState } from '$lib/types/cycle';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/nl.json'), 'utf8')
	) as Record<string, string>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		// ⛔ THE PARAMETERS ARE REALLY INTERPOLATED — this file's whole subject is the string a
		// `{count}` lands in. A stub that discards them renders the countdown as the literal "{count}u".
		mod[key] = (params?: Record<string, unknown>) =>
			catalog[key].replace(/\{(\w+)\}/g, (whole: string, name: string) =>
				params && name in params ? String(params[name]) : whole
			);
	}
	return mod;
});

import CadenceStrip from './CadenceStrip.svelte';

const HOUR = 3_600_000;
/** A Monday 00:00 UTC — the strip parses the week label, so it has to be a real one. */
const WEEK = '2026-W33';

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

/** A live `voting` cycle whose boundary is `ms` away from now. */
function cycleIn(ms: number): CycleState {
	const votingEnds = new Date(Date.now() + ms).toISOString();
	return {
		week: WEEK,
		phase: 'voting',
		votingEndsAt: votingEnds,
		solutionEndsAt: votingEnds,
		closesAt: votingEnds,
		closedAt: null
	};
}

/**
 * Mount the strip and return the countdown's text.
 *
 * ⛔ THE ANTI-VACUITY GATE IS INSIDE. The countdown lives in `{#if cycle}` → `{#if countdown}`; on a
 * strip that rendered neither, "no English unit" is true for free.
 */
function countdown(cycle: CycleState): string {
	app = mount(CadenceStrip, { target: host, props: { cycle } }) as Record<string, unknown>;
	flushSync();
	const el = host.querySelector('.cp-count');
	expect(el, 'the countdown never rendered — this case tests nothing').not.toBeNull();
	return (el!.textContent ?? '').replace(/\s+/g, ' ').trim();
}

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
});

describe('the home cycle countdown speaks the reader’s unit', () => {
	it('⛔ THE DEFECT: fourteen hours reads "14u", not "14h"', () => {
		// REVERT THAT TURNS THIS RED: `` `${Math.max(1, hours)}h` ``.
		// `+ 60s` so the floor cannot land on 13 from clock jitter between the fixture and the render.
		const text = countdown(cycleIn(14 * HOUR + 60_000));
		expect(text).toContain('14u');
		expect(text, 'the English unit is still on the home screen').not.toContain('14h');
		// …inside the sentence that frames it, so this is the real rendered copy and not a fragment.
		expect(text).toContain('sluit over');
	});

	it('⛔ THE DAY ARM IS UNFALSIFIABLE IN DUTCH — so it is pinned at the SOURCE instead', () => {
		// ⛔⛔ SAY THIS OUT LOUD RATHER THAN WRITE A GREEN TEST THAT PROVES NOTHING. `nl`'s
		// `pipeline_dur_day` is "{count}d" — the SAME letter the welded literal used — so a render
		// assertion on this arm passes identically before and after the fix. Only the HOUR arm
		// discriminates in Dutch (h → u). The day unit really does differ elsewhere (de "T", fr "j",
		// pl "dni"), which is what makes the welded literal wrong; it is simply invisible here.
		//
		// So the second arm is guarded the way `cadence-strip.wiring.test.ts` guards this same file:
		// on the source, with comments stripped. Reverting EITHER arm reds this.
		const src = stripComments(
			readFileSync(resolve(process.cwd(), 'src/lib/components/marketplace/CadenceStrip.svelte'), 'utf8')
		);
		expect(src, 'the day arm no longer reaches the catalog').toContain('m.pipeline_dur_day({ count:');
		expect(src, 'the hour arm no longer reaches the catalog').toContain('m.pipeline_dur_hour({ count:');
		// ⚠️ THE LITERALS, ANCHORED ON THE TEMPLATE HOLE. A bare `.not.toContain('d')` is absurd; what
		// must never come back is a unit welded onto an interpolation.
		expect(src, 'a unit is welded onto a template hole again').not.toMatch(/\}[dhms]`/);
		// …and the render really does still produce a day figure, so the source check is not standing
		// in for a component that stopped rendering the arm at all.
		expect(countdown(cycleIn(50 * HOUR))).toContain('2d');
	});

	it('⛔ THE BUCKETING IS THIS SCREEN’S, NOT `duration()`’s', () => {
		// The guard against "simplify this into `duration(ms)`". `duration()` switches to days at 48h
		// and rounds; `remaining()` switches at 24h and floors. A 30-hour remainder is the case where
		// the two visibly disagree — "1d" here, "30u" there — so it is pinned as behaviour.
		expect(countdown(cycleIn(30 * HOUR))).toContain('1d');
	});

	it('⚠️ a sub-hour remainder is clamped to one hour, not rounded down to zero', () => {
		// `Math.max(1, hours)`: `remaining()` has no minutes bucket, so a 20-minute remainder floors to
		// 0 hours and would otherwise render "0u" — a countdown that says the week is already over
		// while the phase is still open.
		const text = countdown(cycleIn(20 * 60_000));
		expect(text).toContain('1u');
		expect(text).not.toContain('0u');
	});

	it('a boundary already passed renders the em dash, not a negative figure', () => {
		// The `ms <= 0` arm, unchanged by this commit and pinned so it stays that way: "sluit over -3u"
		// is worse than saying nothing.
		const text = countdown(cycleIn(-5 * HOUR));
		expect(text).toContain('—');
		expect(text).not.toContain('-5');
	});

	it('⚠️ a CLOSED cycle renders no countdown at all', () => {
		// The complement: an unconditional countdown would put "sluit over —" under a week that is
		// already over, contradicting the phase label beside it.
		app = mount(CadenceStrip, {
			target: host,
			props: { cycle: { ...cycleIn(5 * HOUR), phase: 'closed' } }
		}) as Record<string, unknown>;
		flushSync();
		expect(host.querySelector('.cp-count')).toBeNull();
		// A positive marker, so this is not passing on a strip that failed to render.
		expect(host.querySelector('.cp-label')?.textContent).toBeTruthy();
	});
});
