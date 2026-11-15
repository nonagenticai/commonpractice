// src/lib/components/marketplace/cadence-day.ts — which cadence card is actually today.
//
// ⛔ THE DEFECT. `CadenceStrip` took `today = 'WED'` as a PROP DEFAULT and the only call site
// (`routes/+page.svelte`) never passed it. The live-cycle branch (now `phaseDays(cycle)`, then a
// hand-written `PHASE_DAYS` table — see cycle-phase-days.ts, it was wrong by three days in its own
// right) covered for it — but `data.cycle` is `null` whenever no `marketplace_cycles` row exists for the
// current ISO week, which is prod's standing state. So the home screen — screen #1 of the demo —
// highlighted Wednesday and printed "· vandaag" next to it on a Tuesday, a Friday, a Sunday.
// A dashboard that states the wrong day, on the card that says "in 2 hours", is worse than one
// that states nothing.
//
// Pure and paraglide-free on purpose: it returns a stable DAY KEY, not words, so the weekday
// decision (including the weekend branch) is testable without mounting the component or freezing
// the system clock inside a Svelte runtime.

/** The five cards the strip renders, in render order. The cadence is a Mon–Fri rhythm. */
export const CADENCE_DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI'] as const;
export type CadenceDayKey = (typeof CADENCE_DAYS)[number];

/**
 * The cadence card matching `now`, or `null` on a weekend.
 *
 * ⛔ THE WEEKEND RETURNS `null` — IT DOES NOT CLAMP TO FRI OR MON. `getDay()` is 0=Sun…6=Sat, so
 * a naive `CADENCE_DAYS[getDay() - 1]` reads index -1 on a Sunday and index 5 on a Saturday:
 * `undefined` in both cases, which `[today]` would then quietly turn into a highlight-nothing
 * array with an `undefined` hiding inside it. Answering `null` makes that state explicit and
 * gives the strip its honest weekend rendering: five neutral cards, no highlight, no "· today".
 * Nothing in the Mon–Fri cadence IS happening on a Saturday, and picking the nearest weekday
 * would assert a vote closes or a session runs when it does not — the same class of lie this
 * file removes.
 *
 * Local time, deliberately: the reader's Saturday is the one that matters, not UTC's. The strip
 * only renders client-side (`+page.svelte` gates it behind the loaded `data`, so SSR never
 * reaches it) and there is therefore no server/client weekday to disagree about.
 */
export function cadenceDayKey(now: Date = new Date()): CadenceDayKey | null {
	const dow = now.getDay(); // 0 = Sunday … 6 = Saturday, in the reader's timezone
	return dow >= 1 && dow <= 5 ? CADENCE_DAYS[dow - 1]! : null;
}

// ---------------------------------------------------------------------------------------------
// Rendering the key.
//
// ⛔ THE SECOND DEFECT ON THE SAME CARD. The strip printed `{d.k}` — the literal ASCII strings
// MON TUE WED THU FRI — in ALL EIGHT locales, including Arabic and Hebrew. On the Dutch home
// screen that read "WED · vandaag"; in `ar`/`he` it put a Latin token at the head of an RTL line
// whose only other content was the localized "· today", which is a bidi reorder as well as an
// untranslated string. The five titles and subtitles beside it were localized the whole time.
//
// ⚠️ THE KEY AND THE LABEL ARE DIFFERENT THINGS AND MUST STAY DIFFERENT. `k` is the stable
// English identifier that `phaseDays()` (cycle-phase-days.ts) answers in and that `activeDays`
// membership-tests; it is data, not copy. Only the RENDERING is localized. Nothing may ever
// compare a formatted label against those keys, or the highlight breaks in seven locales at
// once and works in the one the author tested.

/** A fixed UTC reference date for each key. 2026-08-10 is a Monday. */
const REFERENCE_UTC: Record<CadenceDayKey, number> = {
	MON: Date.UTC(2026, 7, 10, 12),
	TUE: Date.UTC(2026, 7, 11, 12),
	WED: Date.UTC(2026, 7, 12, 12),
	THU: Date.UTC(2026, 7, 13, 12),
	FRI: Date.UTC(2026, 7, 14, 12)
};

/**
 * The reader's short name for a cadence day — 'MON' → "Mon" / "ma" / "lun." / "اثنين".
 *
 * `Intl` rather than five message keys × eight catalogs: weekday names are not product copy, no
 * translator should ever be asked to supply them, and every runtime that ships this app already
 * carries them. (`.dk` applies `text-transform: uppercase`, which is a no-op for the Arabic and
 * Hebrew forms and gives "MA"/"LUN." for the Latin ones — the same shape the ASCII keys had.)
 *
 * ⛔ BOTH SIDES ARE PINNED TO UTC. The reference date is built with `Date.UTC` and formatted with
 * `timeZone: 'UTC'`; drop either half and a reader east of UTC+12 or west of UTC-12 formats the
 * neighbouring day, i.e. the WED card would be captioned "Thu". This function must not consult
 * the clock at all — which day is *today* is `cadenceDayKey`'s job, and only that.
 *
 * An unknown locale falls back to the runtime default rather than throwing; `Intl` already
 * resolves e.g. 'nl-BE' → Dutch, so the eight catalog tags need no mapping.
 */
export function cadenceDayLabel(key: CadenceDayKey, locale: string): string {
	try {
		return new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(
			new Date(REFERENCE_UTC[key])
		);
	} catch {
		// A malformed BCP-47 tag makes the Intl constructor throw. A wrong-language weekday beats a
		// blank card, and beats a runtime error taking the whole home screen down with it.
		return new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' }).format(
			new Date(REFERENCE_UTC[key])
		);
	}
}
