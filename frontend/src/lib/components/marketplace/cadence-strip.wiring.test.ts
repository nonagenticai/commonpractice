// cadence-strip.wiring.test.ts — the guards that redden when the DEFECT comes back, as opposed to
// when the helper breaks.
//
// ⛔ WHY THIS FILE EXISTS. `cadence-day.test.ts` has twelve tests of two pure functions, and every
// one of them stays green if you revert `CadenceStrip.svelte`'s prop default to `today = 'WED'` —
// i.e. green with the original bug fully restored. An adversarial pass pointed that out, and it is
// the same class of mistake as a sibling workstream's tick-key test, which also could not go red
// for the thing it was written about. A test that cannot fail for the defect is not evidence that
// the defect is fixed; it is evidence that a helper exists.
//
// The defects here live in a `.svelte` component's markup and prop defaults, which this project
// has no component-render harness for. Source-grep guards are the house answer to exactly that —
// see `audit-categories.backend-contract.test.ts` and `translations-page.enum-labels.test.ts`,
// which both read source from disk and assert on it. These follow that pattern, and each one was
// checked by reverting the fix and watching it fail.
import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CADENCE_DAYS } from './cadence-day';
import { phaseDays } from './cycle-phase-days';

const strip = readFileSync(fileURLToPath(new URL('./CadenceStrip.svelte', import.meta.url)), 'utf8');
const home = readFileSync(fileURLToPath(new URL('../../../routes/+page.svelte', import.meta.url)), 'utf8');
const sandboxes = readFileSync(fileURLToPath(new URL('../../../routes/sandboxes/+page.svelte', import.meta.url)), 'utf8');

// A grep guard that reads an empty file passes everything. Prove we read something first.
test('the guarded sources are actually readable', () => {
	expect(strip.length).toBeGreaterThan(1000);
	expect(home.length).toBeGreaterThan(1000);
	expect(sandboxes.length).toBeGreaterThan(1000);
});

test("⛔ the cadence strip's `today` is DERIVED, never a hardcoded weekday", () => {
	// The original bug in one line: `let { today = 'WED', … } = $props();` plus a call site that
	// never passed `today`. On any non-Wednesday the demo's first screen highlighted the wrong card
	// and captioned it "· vandaag".
	//
	// ⛔ THIS SLICE USED TO BE THE WRONG 40 BYTES AND FIVE OF THE SIX ASSERTIONS BELOW COULD NOT
	// FAIL. It read `strip.slice(indexOf('$props'), indexOf('$props') + 40)` — i.e. FORWARD from the
	// `$props()` CALL, which in this component is `"$props();\n\t// `k` is the STABLE ENGLISH "`.
	// The destructuring, and therefore every prop default, sits BEFORE that index and was never in
	// the window; the loop was searching a comment for day literals. `today = cadenceDayKey() ??
	// 'WED'` passed the whole file — it is not the string `today = 'WED'`, and `cadenceDayKey()` is
	// still present — while restoring exactly the weekend lie cadence-day.ts:22-31 removed: a
	// Saturday reader captioned "WED · today". Slicing the destructuring ITSELF closes it.
	const destructure = strip.slice(strip.indexOf('let {'), strip.indexOf('$props'));
	// A slice guard that reads the wrong region is the defect this test just came back from, so
	// prove the window contains the thing it claims to be checking before checking it.
	// `today` is renamed in the destructuring (`today: todayProp = undefined`) and DERIVED below it:
	// the UTC card under a live cycle (same grid as the phases), the reader's weekday without one.
	expect(destructure).toContain('today: todayProp = undefined');
	expect(destructure).toContain('cycle =');
	expect(strip).toContain('cadenceDayKey()');
	expect(strip).toContain('cardForUtcInstant(Date.now())');
	// No day literal may appear as a default anywhere in the props destructuring.
	for (const day of CADENCE_DAYS) {
		expect(destructure).not.toContain(`'${day}'`);
		expect(strip).not.toContain(`today = '${day}'`);
	}
});

test('⛔ the day KEY stays the stable English identifier — only the render is localized', () => {
	// If a formatted label were ever assigned back into the data path, `activeDays.includes(d.k)`
	// and the keys `phaseDays()` returns would stop matching and the highlight would silently never
	// fire.
	expect(strip).toContain('activeDays.includes(d.k)');
	expect(strip).toContain('cadenceDayLabel(d.k,');
});

test('⛔ the live-phase mapping is DERIVED from the cycle, never a table in this component', () => {
	// ⛔ WHAT THIS REPLACES, AND WHY THE REPLACEMENT IS A DIFFERENT KIND OF ASSERTION. This test used
	// to read:
	//
	//     expect(strip).toMatch(/solution_phase:\s*\['TUE',\s*'WED',\s*'THU'\]/);
	//
	// under the comment "The PHASE_DAYS table must still be written in the English keys." Its intent
	// was the stable-identifier rule above, but what it actually pinned was the LITERAL CONTENT of a
	// table that was wrong by three days — so correcting the map to match the engine turned this
	// line red, and its comment read as a veto on the fix. A guard that must be deleted to fix the
	// bug it sits next to is worse than no guard.
	//
	// The property, not the payload: this component states NO day list of its own, and the day↔phase
	// mapping is asserted from the engine's own numbers in cadence-strip.phase-days.render.test.ts
	// (fixtures built by reproducing `boundariesFor()`, with the cadence as a parameter) rather than
	// by grepping a literal out of the source and agreeing with it.
	expect(strip).toContain('phaseDays(cycle)');
	expect(strip).not.toContain('PHASE_DAYS');
	// No phase may be given a literal day list here, whatever it is spelled with.
	for (const phase of ['voting', 'solution_phase', 'closed']) {
		expect(strip).not.toMatch(new RegExp(`${phase}\\s*:\\s*\\[`));
	}

	// …and the derivation itself only ever answers in the stable English keys — the property the
	// deleted regex was reaching for. Asserted on the FUNCTION across cadences the config can
	// actually be set to, so it holds for every mapping rather than for one transcribed row.
	//
	// ⛔ THIS LOOP USED TO WALK `votingDays` ALONE AND DERIVE `closes = votingEnds + (7 − votingDays)`
	// — i.e. it PINNED THE CADENCE AT 7 DAYS for all six iterations, which makes `closes_at` a Monday
	// in every fixture it produced. Combined with a render test that only exercised `closed` at 4+3,
	// that left `case 'closed': return ['MON']` — the hardcoded table this whole module abolishes —
	// passing the entire suite. `CYCLE_VOTING_DAYS` and `CYCLE_SOLUTION_DAYS` are two INDEPENDENT env
	// vars and nothing forces them to add to 7, so both are walked independently now.
	const week = '2026-W33'; // Monday 2026-08-10 00:00 UTC
	const DAY = 24 * 60 * 60 * 1000;
	const start = Date.UTC(2026, 7, 10);
	let sawNonSevenClose = false;
	for (let votingDays = 1; votingDays <= 6; votingDays++) {
		for (let solutionDays = 1; solutionDays <= 6; solutionDays++) {
			const votingEnds = start + votingDays * DAY;
			const closes = votingEnds + solutionDays * DAY;
			if (votingDays + solutionDays !== 7) sawNonSevenClose = true;
			for (const phase of ['voting', 'solution_phase', 'closed'] as const) {
				const days = phaseDays({
					week,
					phase,
					votingEndsAt: new Date(votingEnds).toISOString(),
					solutionEndsAt: new Date(closes).toISOString(),
					closesAt: new Date(closes).toISOString(),
					closedAt: null
				});
				for (const d of days) expect(CADENCE_DAYS).toContain(d);
				// No card may be claimed twice, and a Mon–Fri strip cannot hold more than five.
				expect(new Set(days).size).toBe(days.length);
				expect(days.length).toBeLessThanOrEqual(CADENCE_DAYS.length);
				// The week is over during `closed`: no activity card may be lit under the
				// "Week closed · winner announced" header. See cycle-phase-days.ts for the reasoning
				// and cadence-strip.phase-days.render.test.ts for the on-screen proof.
				if (phase === 'closed') expect(days).toEqual([]);
			}
		}
	}
	// The loop must actually have produced the cadences the old one could not reach.
	expect(sawNonSevenClose).toBe(true);
});

test('⛔ no hardcoded relative time survives in the cadence subtitles', () => {
	// `mkt_cadence_wed_s` was the literal string "in 2 hours" / "over 2 uur" — a Wednesday-morning
	// interval baked into all eight catalogs, false at every other moment. The strip may quote a
	// countdown ONLY from a real cycle boundary, which is what `remaining()` does.
	expect(strip).not.toContain('mkt_cadence_wed_s');
	// WED must resolve to NO subtitle rather than to a new invented one. It keeps the `sKey`
	// FIELD (the array is typed `sKey: string | null`, and dropping the key entirely would make
	// the row a different shape from its four siblings) — what matters is that its value is null.
	const wedEntry = strip.slice(strip.indexOf("k: 'WED'"), strip.indexOf("k: 'THU'"));
	expect(wedEntry).toContain('sKey: null');
	expect(wedEntry).not.toMatch(/sKey:\s*'/);
});

test("⛔ the sandboxes run drawer localizes its status and does NOT glue a bare noun to a number", () => {
	// Two separate regressions guarded together because they sit on the same two lines.
	expect(sandboxes).toContain('runStatusLabel(r.status)');
	// The raw enum must not be rendered as text. (It stays as a CSS class, which is fine.)
	expect(sandboxes).not.toContain('>{r.status}<');
	// `{count} LLM calls` renders "1 LLM calls" — this key carries NO plural machinery, so the count
	// must not lead the noun. The label:value form is count-agnostic in every language.
	//
	// ⚠️ CORRECTED: this comment used to justify that with "there are no ICU plurals in these
	// catalogs". There are ten (see lib/i18n/icu-number-params.test.ts, which asserts that list is
	// exhaustive). The reason still holds for THIS key — it is a plain message — but the premise as
	// written was false and would have talked the next reader out of a real option.
	expect(sandboxes).not.toMatch(/\{r\.llmCalls\}\s*llm/);
	// ⛔ AND THE COUNT IS GROUPED. Being a PLAIN message is exactly why it takes `num()` at the call
	// site (mechanism A) rather than a `countNum` local in the catalog — and it must, because this
	// same file renders `num(s.llmCallsToday, locale.current)` at :289 and :344, so left raw one
	// Dutch screen showed "1.207" in the table and "LLM-aanroepen: 1207" in the run list.
	expect(sandboxes).toContain(
		'sandboxes_run_llm_calls({ count: num(r.llmCalls, locale.current) })'
	);
});
