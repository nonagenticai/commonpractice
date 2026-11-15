// src/lib/utils/format.ts — small display helpers shared by the Ops screens.
import * as m from '$lib/paraglide/messages';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ⛔ EVERY FIGURE THIS MODULE PRINTS USES LATIN DIGITS, PINNED. A PRODUCT DECISION, NOT A TEST FIX.
//
// THE MEASUREMENT. The default NUMBERING SYSTEM for the generic `ar` tag is not a fixed fact — it
// is a property of whichever ICU/CLDR the code happens to be running on:
//
//     new Intl.NumberFormat('ar').format(1234567)
//       → '1,234,567'    Node 25.8 / ICU 78 (CLDR moved `ar` to `latn`)
//       → '١٬٢٣٤٬٥٦٧'    the CI runner's older ICU (CLDR `arab`)
//
// And these helpers do not run on OUR ICU. They run in the READER'S BROWSER. So without a pin, two
// Arabic readers on two Chrome versions see two different spellings of the same number with no
// deploy between them, and a developer proving a screen locally cannot state what production
// renders. Determinism across ICU builds is the requirement; `latn` is the value that satisfies it.
//
// WHY `latn` IS ALSO THE RIGHT ANSWER, not merely the deterministic one:
//   1. Every OTHER figure on the same screens is already Latin and cannot be otherwise — run and
//      trace ids, block/flow slugs, HTTP status codes, model names, and the money the backend
//      sends. A stat card rendering `١٬٢٣٤` beside a trace id reading `1234` is worse than uniform
//      Latin: the reader has to decide which of two number systems each figure is in.
//   2. The catalogs already made this choice. `messages/ar.json` contains ZERO Arabic-Indic digits
//      and 62 Latin ones ('256', '50', '20', …). Rendering `arab` here would put the two halves of
//      one sentence in two scripts.
//   3. Latin digits are the ordinary convention in Arabic business and technical copy.
//
// ⚠️ THE ICU-MESSAGE PATH CARRIES THE SAME PIN, AND THE TWO MUST MOVE TOGETHER. The numbers inside
// a plural message are formatted by paraglide's registry, not by this file; all eight catalogs
// therefore declare `local countNum = count: number numberingSystem=latn` on all eleven plural
// keys (see src/lib/i18n/icu-number-params.test.ts). Pinning only one of the two paths would be
// WORSE than pinning neither — it would put `1,234` and `١٬٢٣٤` in the same sentence on an
// old-ICU runtime, which is the exact "two spellings of one figure in one file" defect the
// grouping work already exists to remove. Reversing this decision means reverting both halves.
//
// ⚠️ SPELLED AS AN OPTION, NOT AS A `-u-nu-latn` LOCALE TAG. The tag arrives from paraglide
// (`'ar'`, `'he'`) and is also handed to `Intl.PluralRules` by the compiled messages; rewriting it
// here would make this module's idea of the locale differ from the rest of the app's.
const LATN = { numberingSystem: 'latn' } as const;
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * "12m ago" / "2h ago" / "3d ago" — coarse relative time from an ISO string,
 * localized. Reads the active locale via the paraglide messages, so a call in a
 * component template re-evaluates on locale switch (same mechanism as DotStatus).
 */
export function timeAgo(iso: string | null): string {
	if (!iso) return '—';
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return '—';
	const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
	if (secs < 60) return m.timeago_sec({ count: secs });
	const mins = Math.round(secs / 60);
	if (mins < 60) return m.timeago_min({ count: mins });
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) {
		const rem = mins % 60;
		return rem ? m.timeago_hour_min({ hours: hrs, mins: rem }) : m.timeago_hour({ count: hrs });
	}
	const days = Math.floor(hrs / 24);
	const remH = hrs % 24;
	return remH ? m.timeago_day_hour({ days, hours: remH }) : m.timeago_day({ count: days });
}

/**
 * An ELAPSED DURATION in milliseconds, as a single coarse figure: "41m" / "30h" / "3d".
 *
 * Why this exists at all: /pipeline showed "AVG TIME TO LIVE — / none live yet" beside "IN
 * PRODUCTION 1 / live now" for a card that shipped in 41 minutes. The server sent whole days, so a
 * real interval arrived as `0`, and the page then used that magnitude as a data-existence test.
 * The backend now sends `avgTimeToLiveMs`; picking a unit is this function's job, because which
 * unit reads naturally is a presentation question and any unit chosen server-side re-creates the
 * same rounding bug one order of magnitude down.
 *
 * Buckets: under an hour → minutes · under 48 h → hours · from 48 h → days. The 48 h floor (not
 * 24 h) is deliberate: a 30-hour promotion must not be flattened to "1d", which is the same lie in
 * smaller print.
 *
 * ⛔ ITS OWN `pipeline_dur_*` KEY FAMILY — DO NOT REUSE `timeago_*`. Those are PAST-TENSE phrases:
 * `ar.json` renders them with a leading `قبل` ("ago"), so an average duration would read as "41
 * minutes ago", a different proposition entirely. Number and unit live together INSIDE the catalog
 * message rather than being concatenated here, so the translator owns the order — the previous
 * code built `` `${days}d` `` in the template, which is untranslatable and, under `dir="rtl"`,
 * hands the visual order of the run to the Unicode bidi algorithm instead of to someone who speaks
 * the language.
 *
 * No ICU plural categories, matching every other duration string in these catalogs: the unit is
 * ABBREVIATED, and abbreviations do not inflect in any of the 8 locales — which is exactly how the
 * `timeago` family gets away with one form in Polish (3 CLDR categories) and Arabic (6). Spelling
 * the units out is a translator's workstream, not a rider on a metrics fix.
 *
 * ⛔ THAT DEFENCE IS ONLY TRUE WHILE EVERY LOCALE ACTUALLY ABBREVIATES — AND POLISH DID NOT.
 * `pl.json` shipped `timeago_day: "{count}dni temu"` and `timeago_day_hour: "{days}dni {hours}godz
 * temu"`. `dni` is not an abbreviation, it is the plural of `dzień`, so it inflects: at `count = 1`
 * a Polish reader was shown "1dni temu" — "1 days ago" — and `timeago_day_hour` is reachable at
 * `days = 1` (any interval from 24 h to 47 h with a remainder), so both were live. Fixed by
 * abbreviating to `dn.`, which is standard Polish and does not inflect, rather than by adding
 * plural categories to one locale: the `countPlural`/`countNum` guard in
 * `$lib/i18n/icu-number-params.test.ts` is all-eight-locales-or-none, so pluralising here would
 * mean authoring six Arabic categories to satisfy a guard, for a string that is abbreviated
 * everywhere else by design.
 *
 * ⚠️ SO THE RULE HAS A PRECONDITION, AND IT IS NOT SELF-ENFORCING: this family is safe from
 * inflection ONLY for as long as no catalog spells a unit out. A translator writing the natural
 * word rather than the abbreviation re-opens the bug silently, in a locale nobody demos in. That
 * is what happened here, and nothing in CI would have caught it — it was found by reading the
 * eight values side by side.
 *
 * Reads the locale through the paraglide message functions on every call, exactly like `timeAgo`,
 * so a call site inside a component template re-renders on a locale switch.
 */
export function duration(ms: number): string {
	// Clamp rather than render a negative figure: a card whose `live_at` precedes its `created_at`
	// is corrupt data, and "-3d" on a stat card explains nothing to the person looking at it.
	const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
	const mins = Math.round(safe / 60_000);
	if (mins < 60) return m.pipeline_dur_min({ count: mins });
	// Rounded (not floored) at each step, so 59.7 minutes surfaces as "1h" and never as "60m".
	const hrs = Math.round(mins / 60);
	if (hrs < 48) return m.pipeline_dur_hour({ count: hrs });
	return m.pipeline_dur_day({ count: Math.round(hrs / 24) });
}

/**
 * A DEMO RUN's elapsed time in milliseconds, as a single figure: "420ms" / "3.4s" / "1m 12s".
 *
 * ⛔ A SIBLING OF `duration()`, NOT AN EXTENSION OF IT. Do not merge the two and do not "simplify"
 * this by calling that one. `duration()` floors at MINUTES on purpose — it renders "time to live",
 * a promotion interval measured in hours and days, where sub-minute precision is noise. Every
 * demo run this function will ever be handed lives BELOW that floor: a 2-block flow finishes in a
 * few hundred milliseconds, so routing it through `duration()` prints "0m" for every solution on
 * the board and the page then reads that magnitude as absence. That is precisely the /pipeline
 * "AVG TIME TO LIVE —" defect (server rounded to whole days, a 41-minute interval arrived as 0),
 * one order of magnitude down. It is also why the wire field is `demoMs` and not `demoSeconds`:
 * seconds would have re-created it in the DTO instead of in the formatter.
 *
 * Buckets: under a second → whole milliseconds · under a minute → seconds to one decimal · from a
 * minute → minutes + whole seconds. The decimal exists because 1.2 s and 1.9 s are visibly
 * different demos and "1s" for both is the same flattening in smaller print; it stops at one place
 * because a third significant digit on a wall-clock measurement is precision nobody has.
 *
 * ⛔ ITS OWN `demo_dur_*` KEY FAMILY — DO NOT REUSE `pipeline_dur_*` OR `timeago_*`. `pipeline_dur_*`
 * has no sub-minute members at all, and `timeago_*` are PAST-TENSE phrases (`ar.json` renders them
 * with a leading `قبل`, "ago"), so a demo duration would read as "420 milliseconds ago" — a
 * different proposition. Number and unit live together INSIDE the catalog message and are never
 * concatenated here, so the translator owns the order and `dir="rtl"` does not hand the visual run
 * to the bidi algorithm. `demo_dur_min_sec` carries BOTH numbers for the same reason.
 *
 * No ICU plural categories, matching every other duration string in these catalogs: the units are
 * ABBREVIATED, and abbreviations do not inflect in any of the 8 locales.
 *
 * Reads the locale through the paraglide message functions on every call, exactly like `timeAgo`,
 * so a call site inside a component template re-renders on a locale switch.
 *
 * ⛔ `locale` IS REQUIRED, AND IT IS THE SECONDS BRANCH THAT NEEDS IT. The tenths bucket used to
 * build its figure with `(tenths / 10).toFixed(1)` — a hard-coded '.' decimal separator, on the one
 * number in this module that HAS a decimal part. Six of the eight catalogs (nl, de, fr, es, pl and
 * the two RTL ones via their Latin digits) write that separator as ',', so a Dutch reader watching
 * a 3.4-second demo read "3.4s", which in Dutch is three-thousand-four-hundred seconds' worth of
 * punctuation on a figure whose unit is already 's'. The parameter has NO DEFAULT for the same
 * reason `num`'s does not (see its header): a default compiles at every site that forgets, and
 * forgetting is how the defect spread the first time. `svelte-check` names the callers instead.
 *
 * ⚠️ ONLY the seconds branch is localized, and that is not an oversight. `demo_dur_ms` is guarded
 * by `whole < 1000`, and no locale groups below a thousand; `demo_dur_min_sec` carries two integers
 * a demo run cannot push past three digits. Neither has a fraction, which is the part that differs.
 */
export function demoDuration(ms: number, locale: string): string {
	// Clamp rather than render a negative figure — same reasoning as `duration()`.
	const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
	// ⚠️ Each bucket tests the value it is about to PRINT, never the raw one. Rounding after the
	// comparison is how a formatter emits "60.0s" (999.6 ms → "1000ms", 59 960 ms → "60.0s"): each
	// is the next bucket's answer wearing this bucket's unit.
	const whole = Math.round(safe);
	if (whole < 1000) return m.demo_dur_ms({ count: whole });
	// Tenths of a second as an integer — `(x / 1000).toFixed(1)` on a float holds 3.4000000000000004.
	const tenths = Math.round(whole / 100);
	if (tenths < 600) return m.demo_dur_sec({ count: decimal1(tenths / 10, locale) });
	// Rounded ONCE, then split, so the seconds part can never come out as 60.
	const totalSecs = Math.round(whole / 1000);
	return m.demo_dur_min_sec({ mins: Math.floor(totalSecs / 60), secs: totalSecs % 60 });
}

/**
 * An LLM spend figure, in US dollars.
 *
 * It used to render a `€` glyph — its own comment called it "cosmetic" — over a value that is
 * unambiguously USD: every field feeding it is named `…Usd`, the ledger column is
 * `usage_events.cost_usd`, and OpenRouter (the authority behind the tenant budgets) bills in
 * dollars. A wrong currency symbol on a money figure is not cosmetic; at today's rates it
 * misstated every spend number on /usage, /it-dash and /sandboxes by roughly a tenth.
 *
 * Whether the value is an ESTIMATE now depends on the row, and is no longer a blanket property of
 * the column. `cost_usd` used to be priced from one flat per-token rate that could not match real
 * per-model pricing, so every surface hedged it with `usdEstimated`. Since migration 0053 the
 * broker records HOW each call was priced in `usage_events.price_source`, and a call priced from
 * the provider's own reported charge is the invoice, not an approximation of it. Use `usdMaybe`
 * with that provenance rather than hedging unconditionally — and keep hedging wherever any part of
 * the figure was flat-estimated.
 *
 * ⛔ AND IT WAS THE LAST `.toFixed(` IN THIS MODULE, IN A MODULE THAT DOCUMENTS `.toFixed(` AS THE
 * DEFECT. `` `$${n.toFixed(2)}` `` hard-codes BOTH the decimal separator and the glyph's position.
 * Measured on the running app, one `/sandboxes` table row read `1,2 GB` — correct Dutch, because
 * `gb()` was fixed — directly beside `~$0.51`. `/it-dash` put `P95 2,47s` next to `~$1.29`.
 * Money was the only figure in the product still written in the developer's language.
 *
 * ⚠️ `currencyDisplay: 'narrowSymbol'`, NOT the default. Measured under Bun 1.3.14 and Node 25.8.1
 * (byte-identical, so CI and SSR cannot disagree) for `1234.56`:
 *
 *   en `$1,234.56` · nl `$ 1.234,56` · de `1.234,56 $` · fr `1 234,56 $` · es/pl `1234,56 $`
 *   ar `‏1,234.56 US$` · he `‏1,234.56 ‏$`
 *
 * The DEFAULT display turns `$` into `US$` / `$US` / `USD` in four catalogs — a copy change nobody
 * asked for. `narrowSymbol` changes only what was actually wrong: the separators and the glyph's
 * POSITION (de/fr/es/pl put it after the figure).
 *
 * ⛔ THREE MEASURED FACTS THAT WILL BITE A FIXTURE AUTHOR:
 *   1. `ar` emits `US$` even under `narrowSymbol` — CLDR has no narrow USD form for Arabic. The
 *      claim "narrowSymbol keeps the $ glyph" is false for 1 of 8 locales.
 *   2. `ar` and `he` inject `U+200F` RIGHT-TO-LEFT MARK (he: TWO). Spell them as named escapes in
 *      any expectation, or the fixture is unreadable and its failure looks like a formatting bug.
 *   3. `pl` and `es` set `minimumGroupingDigits: 2`, so a FOUR-digit figure is not grouped at all
 *      in either. A `1234.56` fixture proves nothing in 2 of 8 locales — use a 7-digit one.
 *
 * ⚠️ `locale` IS REQUIRED WITH NO DEFAULT, like every other formatter here — see the block above
 * `num()`. That requirement is what made `svelte-check` enumerate all 17 call sites.
 *
 * ⚠️ `digits` EXISTS FOR THE SUB-CENT CASE AND MUST NOT BE DROPPED. `ChatPanel`/`RunConsole` render
 * FOUR decimals deliberately: a single chat turn on a cheap model rounds to `$0.00` at two, which
 * is the exact defect `0edaad5` ("Local inference priced $0.00, so the ceiling that guards spend
 * could never fire") already cost this repo once.
 */
export function usd(n: number, locale: string, digits = 2): string {
	// Same non-number guard as `fixed()`, for the same measured reason: the `catch` formats the SAME
	// value, so without this a bad VALUE (rather than a bad tag) re-throws out of the catch and
	// unmounts the screen. `remainingUsd` is `number | undefined` on the wire, so this is closer to
	// reachable here than it is for `num()`.
	// ⛔ ANY NON-NUMBER IS THE EM DASH, NOT `String(n)`. The first version mirrored `fixed()`'s
	// `n == null ? '—' : String(n)`, which adversarial review measured rendering `usd([], 'de')` as
	// the EMPTY STRING — dropped silently into the middle of `notification_budget_low_body` — and
	// `usd('50','de')` as a bare `"50"` with no glyph and en punctuation. On `main` these threw
	// loudly. A money formatter has no business guessing at a non-number: '—' is the sentinel this
	// module already uses for "no figure", and it is honest for all of them.
	if (typeof n !== 'number') return '—';
	const opts: Intl.NumberFormatOptions = {
		style: 'currency',
		currency: 'USD',
		currencyDisplay: 'narrowSymbol',
		minimumFractionDigits: digits,
		maximumFractionDigits: digits,
		...LATN,
	};
	try {
		return new Intl.NumberFormat(locale, opts).format(n);
	} catch {
		// ⛔ THE SAME OPTIONS WITH NO TAG — never `n.toLocaleString()` bare, which `num()` uses. That
		// fallback would drop `style:'currency'` and print a bare number where a dollar figure was.
		return new Intl.NumberFormat(undefined, opts).format(n);
	}
}

/**
 * The same figure marked as the estimate it is — for headline stats and column headers.
 *
 * ⛔ NOT `'~' + usd(...)`, AND THIS IS EMPIRICAL RATHER THAN AESTHETIC. `formatRange(n, n)` emits
 * CLDR's own per-locale approximation sign, correctly placed. Measured, same two runtimes:
 *
 *   en `~$12.34` · nl `$ ~12,34` ← sign AFTER the symbol
 *   fr `≃12,34 $` ← U+2243, not a tilde · de `≈12,34 $` ← U+2248, not a tilde
 *   ar `‏~12.34 US$` · he `‏~12.34 ‏$` ← RLM BEFORE the sign
 *
 * So a hard-coded `~` is wrong in THREE of eight locales — wrong glyph in fr and de, wrong position
 * in nl. And `'~' + usd(…)` in a `dir="rtl"` document is worse than wrong: the tilde is bidi class
 * ON at `sot`, so under UAX#9 N1/N2 it takes the paragraph level and lays out at the RIGHT end of
 * the run — an Arabic reader sees it on the far side of the number it qualifies. That is the same
 * hazard the header of this module already documents for hand-concatenated units.
 *
 * A catalog message would fix the position but ask eight translators to independently rediscover
 * `≃` and `≈`, and `catalogs.test.ts` would accept eight identical `~{amount}` values. ICU already
 * knows. Zero new keys.
 *
 * The `catch` is not defensive padding: `formatRange` is NumberFormat v3, and an `Intl` throw inside
 * a `$derived` unmounts the whole screen — the reason every formatter in this module has one.
 */
export function usdEstimated(n: number, locale: string, digits = 2): string {
	// ⛔ ANY NON-NUMBER IS THE EM DASH, NOT `String(n)`. The first version mirrored `fixed()`'s
	// `n == null ? '—' : String(n)`, which adversarial review measured rendering `usd([], 'de')` as
	// the EMPTY STRING — dropped silently into the middle of `notification_budget_low_body` — and
	// `usd('50','de')` as a bare `"50"` with no glyph and en punctuation. On `main` these threw
	// loudly. A money formatter has no business guessing at a non-number: '—' is the sentinel this
	// module already uses for "no figure", and it is honest for all of them.
	if (typeof n !== 'number') return '—';
	const opts: Intl.NumberFormatOptions = {
		style: 'currency',
		currency: 'USD',
		currencyDisplay: 'narrowSymbol',
		minimumFractionDigits: digits,
		maximumFractionDigits: digits,
		...LATN,
	};
	try {
		return new Intl.NumberFormat(locale, opts).formatRange(n, n);
	} catch {
		return `~${usd(n, locale, digits)}`;
	}
}

/**
 * A spend figure that hedges itself only when it actually needs to.
 *
 * `estimated` should be true when ANY call behind the number was priced by the flat fallback or
 * predates `price_source`. One estimated call in an aggregate makes the whole aggregate an
 * estimate — the tilde is about the weakest link, not the majority.
 */
export function usdMaybe(n: number, estimated: boolean, locale: string, digits = 2): string {
	return estimated ? usdEstimated(n, locale, digits) : usd(n, locale, digits);
}

/**
 * Latency: "—" when unknown, whole milliseconds under a second, else seconds to two places.
 *
 * ⛔ `locale` IS REQUIRED, FOR EXACTLY THE REASON IT IS REQUIRED ON `demoDuration`, AND THIS
 * FUNCTION IS WHY THAT FIX WAS INCOMPLETE. The seconds branch was `(n / 1000).toFixed(2)` — the
 * same hard-coded '.' decimal separator, in the same module, imported on the same line of
 * `RunConsole.svelte` as the `num()` calls added to fix its siblings. Six of the eight catalogs
 * write that separator as ',', so the run console rendered a Dutch reader
 *
 *     1.207 LLM-aanroepen · 1.234.567+98.765 tokens        ← grouped, Dutch
 *     uitvoering geslaagd · 3.46s                          ← this function, English punctuation
 *
 * in ONE component: three conventions in a single sentence, where before the fix there had been
 * one (wrong) convention throughout. An inconsistency introduced by a consistency fix is worse
 * than the defect, because the reader can no longer tell which figure to trust. Same defect on
 * /it-dash's P95 stat card and in `ops_alert_high_latency_detail` ("2.47s, above the 2.00s
 * target"), which is why `opsAlertDetail` now takes a locale too.
 *
 * ⛔ ROUND FIRST, THEN BUCKET — `demoDuration`'s rule, and this function was breaking it. It tested
 * `n < 1000` on the RAW value and only then printed, so 999.6 ms came out "1000ms": the next
 * bucket's answer wearing this bucket's unit, which is the "60.0s" defect one order of magnitude
 * down. Worse after the fix than before it, because `num()` then GROUPS that thousand and Dutch
 * read "1.000ms" — a separator inside a figure the bucket exists to guarantee cannot have one.
 * Rounding first makes 999.6 render "1,00s", which is what it is.
 *
 * ⚠️ THE UNITS STAY ABBREVIATED AND UNTRANSLATED — same call `duration()` and `demoDuration()`
 * make, and for the same reason: 'ms' and 's' do not inflect in any of the 8 locales.
 */
export function ms(n: number | null, locale: string): string {
	if (n == null) return '—';
	const whole = Math.round(n);
	return whole < 1000 ? `${num(whole, locale)}ms` : `${decimal2(whole / 1000, locale)}s`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Numbers and dates in the READER'S locale — the app's, not the runtime's.
//
// ⛔ THE DEFECT. `num()` was `n.toLocaleString()`, and the four date labels on the charts called
// `toLocaleDateString([], …)`, `toLocaleTimeString([], …)` and `toLocaleDateString(undefined, …)`.
// A bare call, `[]` and `undefined` are three spellings of ONE thing: the RUNTIME's default locale
// — the browser's UI language, or under Node the machine's. That is a different value from the
// locale the app is rendering in. In a Dutch UI on an en-US machine, 1207 came out "1,207" instead
// of "1.207" — the thousands separator and the decimal separator INVERTED, which is not a cosmetic
// difference to a Dutch reader looking at a spend figure — and a chart tooltip read "Aug 7"
// instead of "7 aug", in an interface whose every other word was Dutch.
//
// ⚠️ HOW WIDE THIS ACTUALLY IS — stated at its real size, not inflated. `project.inlang/settings.json`
// sets `baseLocale: "en"` and paraglide resolves localStorage → cookie → navigator → base, so for a
// reader who never opens the language switcher the app locale and the browser locale AGREE and
// nothing here is visible. The gap opens the moment someone PICKS a locale in the Topbar
// (Topbar.svelte:203 → `locale.set()` → localStorage `PARAGLIDE_LOCALE`) — which is exactly what a
// Dutch demo on an English laptop does, first click. Narrow trigger; once tripped, every figure on
// every screen is formatted in the wrong language at once.
//
// ⛔ THE LOCALE IS AN ARGUMENT — THIS MODULE MUST NOT IMPORT THE LOCALE STORE. `$lib/stores/locale.svelte`
// holds a `$state` rune; reading it from a plain `.ts` file binds every importer (including the
// pure-logic specs next door, which mock nothing but the message module) to the Svelte runtime.
// The idiom already in the codebase is `components/marketplace/cadence-day.ts`: the function takes
// `locale`, and the component passes `locale.current` (CadenceStrip.svelte:129). That read IN THE
// TEMPLATE is also what makes these re-render on a locale switch — `locale.current` is the very
// rune paraglide's `getLocale()` is rebound to (stores/locale.svelte.ts:89), so a formatted number
// now reacts exactly like the `m.*()` label sitting beside it. Pinned by the switch test in
// routes/winner/winner-page.locale-numbers.render.test.ts rather than asserted here.
//
// ⚠️ THE PARAMETER IS REQUIRED, WITH NO DEFAULT — ON PURPOSE. `locale = undefined` would be the
// defect wearing a nicer spelling: it compiles at every call site that forgets to pass one, and
// forgetting is precisely how 32 call sites came to render in the browser's language. Required
// means `svelte-check` names every site that drops it, which is the only mechanism here that
// survives the next person adding a stat card.
//
// ⚠️ ALL OF THESE TAKE `locale: string`, NOT the `Locale` union — same signature as
// `cadenceDayLabel`. `Intl` already resolves regional variants ('nl-BE' → Dutch), so the eight
// catalog tags need no mapping, and a `Locale`-typed parameter would force a cast at any call site
// that has a raw tag. The malformed-tag fallbacks below exist for the same reason they exist in
// cadence-day.ts: a `RangeError` from an `Intl` constructor takes down the whole screen, and a
// figure grouped in the wrong language is the smaller failure by a wide margin.
// ─────────────────────────────────────────────────────────────────────────────────────────────

// A `Map`, not a plain object: a typed unit like "constructor" or "__proto__" must miss, not hit a
// prototype member and hand `Intl` a function as `unit` (RangeError → the challenge page unmounts).
const DURATION_UNITS: ReadonlyMap<string, 'hour' | 'minute' | 'day'> = new Map([
	['h', 'hour'], ['hr', 'hour'], ['hrs', 'hour'], ['hour', 'hour'], ['hours', 'hour'], ['u', 'hour'], ['uur', 'hour'],
	['min', 'minute'], ['mins', 'minute'], ['minute', 'minute'], ['minutes', 'minute'], ['minuten', 'minute'],
	['d', 'day'], ['day', 'day'], ['days', 'day'], ['dag', 'day'], ['dagen', 'day']
] as const);
const DURATION_TEXT = /^\s*(~|≈|ca\.?)?\s*(\d[\d.,]*)\s*([a-z_]+)\.?\s*$/i;

/** "2" → 2, "1,5" / "1.5" → 1.5. Anything with a thousands-looking or mixed separator ("1,000",
 *  "1.000,5") is ambiguous across locales and returns null, so the caller shows the text as typed. */
function durationNumber(s: string): number | null {
	if (/^\d+$/.test(s)) return Number(s);
	const dec = /^(\d+)[.,](\d{1,2})$/.exec(s);
	return dec ? Number(`${dec[1]}.${dec[2]}`) : null;
}

/**
 * A free-text duration figure ("~2 hrs", "3 hours", "30 min") in the reader's language: "~2 uur",
 * "2 Stunden". Challenge metrics are typed as text (≤40 chars) and the seed wrote English units, so
 * a Dutch page showed "~2 hrs". The unit word and its plural come from `Intl` (style 'unit'), with
 * Latin digits like every other figure here. Anything that does not parse as one unambiguous number
 * plus a known unit is returned unchanged — never guessed at.
 *
 * ⛔ NEVER THROWS. It renders inside the challenge page's template with no error boundary, so any
 * throw would blank the page for every viewer; every failure returns the input as typed.
 */
export function durationText(raw: string, locale: string): string {
	try {
		const match = DURATION_TEXT.exec(raw ?? '');
		if (!match) return raw;
		const unit = DURATION_UNITS.get(match[3]!.toLowerCase());
		if (!unit) return raw;
		const value = durationNumber(match[2]!);
		if (value === null || !Number.isFinite(value)) return raw;
		const opts = { style: 'unit', unit, unitDisplay: 'long', ...LATN } as const;
		let text: string;
		try {
			text = new Intl.NumberFormat(locale, opts).format(value);
		} catch {
			text = new Intl.NumberFormat(undefined, opts).format(value);
		}
		return match[1] ? `~${text}` : text;
	} catch {
		return raw;
	}
}

/**
 * A whole figure, grouped for the reader: 1207 → "1,207" (en) · "1.207" (nl) · "1 207" (fr).
 *
 * ⛔ THE NON-NUMBER GUARD IS NOT DEFENSIVE PADDING — WITHOUT IT THE `catch` RE-THROWS.
 * The `try` exists for one thing: a malformed locale tag makes the `Intl` constructor raise
 * `RangeError`, and an uncaught throw inside a `$derived` unmounts the whole screen (see the
 * header block above). But the fallback calls `n.toLocaleString()` on THE SAME value, so when the
 * bad input is the VALUE rather than the tag it does nothing at all: `num(undefined, 'nl')` and
 * `num(null, 'nl')` both throw `TypeError: Cannot read properties of undefined (reading
 * 'toLocaleString')` out of the catch block, and the screen goes down anyway — the exact outcome
 * the try/catch is documented as preventing. Measured.
 *
 * ⚠️ NOT REACHABLE FROM ANY CALL SITE TODAY, and it is worth saying so rather than implying a live
 * bug: all wrapped values are typed `number`, and the two most exposed (`rowCount`, `total`) are
 * `notNull` in the schema. This closes the hole ahead of the first `number | null` field, which is
 * one API change away — `ms()` in this same module already takes one.
 *
 * ⚠️ `NaN` AND `Infinity` STILL GO THROUGH `Intl`, DELIBERATELY. They are numbers, and `Intl`
 * localizes them ("NaN"/"∞" in en, "ليس رقمًا"/"∞" in ar) — `icu-number-params.test.ts` relies on
 * exactly that string to prove the plural trap. Short-circuiting them to `String(n)` would replace
 * a translated token with an English one. '—' is the sentinel `ms()`, `timeAgo()` and `fullDate()`
 * in this module already use for "no figure".
 */
export function num(n: number, locale: string): string {
	if (typeof n !== 'number') return n == null ? '—' : String(n);
	try {
		return n.toLocaleString(locale, LATN);
	} catch {
		return n.toLocaleString(undefined, LATN);
	}
}

/**
 * The reader's punctuation on a figure that must NOT be rounded — every digit the value holds.
 *
 * ⛔ WHY THIS IS NOT `num()`. `num()` is `toLocaleString`, whose default `maximumFractionDigits`
 * is 3. That is right for a count and wrong for a value the screen is ECHOING BACK to the person
 * who typed it. Measured at render level on /llm-settings, whose backend accepts
 * `z.number().min(0).max(2)` with NO decimal bound:
 *
 *     temperature 0.0001    num() → "0"      ← a set value reported as unset
 *     temperature 0.999999  num() → "1"      ← a different setting than the one saved
 *
 * The `<input type="number">` two panes away shows the raw value at the same moment, so the screen
 * disagreed with itself. And "0" for a value that IS set collides head-on with that page's own
 * "ABSENCE IS STILL ABSENCE — a null temperature renders the em dash, not '0'" invariant: the fix
 * for one spelling of "the panel states something the field does not hold" cannot reintroduce
 * another.
 *
 * ⛔ AND NOT `maximumFractionDigits: 20` EITHER, WHICH WAS THE OBVIOUS VERSION. 20 is the ceiling
 * `Intl` allows, and it still collapses a small value to nothing: measured, `1e-40` formats as "0"
 * with `maximumFractionDigits: 20` and as "0,0000…0001" with `maximumSignificantDigits: 21`. A
 * `real` column and a `type="number"` input both accept such a value. Significant digits are also
 * the RIGHT unit for the property wanted here: an IEEE double round-trips through at most 17
 * significant decimal digits, so 21 (the spec's maximum) renders every double this can be handed
 * exactly, with no trailing zeros invented — `exact(1, 'nl')` is "1", not "1,000000000000000000000".
 *
 * ⚠️ GROUPING STAYS ON, deliberately un-special-cased. This is a general formatter and a large
 * value should still group for the reader; its one caller today is bounded at 2, so the separator
 * it can actually emit is the DECIMAL one — which is the whole point, '.' being the THOUSANDS
 * separator in five of the eight catalogs.
 *
 * Same non-number guard and malformed-tag fallback as `num`, for the reasons documented there.
 */
export function exact(n: number, locale: string): string {
	if (typeof n !== 'number') return n == null ? '—' : String(n);
	const opts: Intl.NumberFormatOptions = { maximumSignificantDigits: 21, ...LATN };
	try {
		return new Intl.NumberFormat(locale, opts).format(n);
	} catch {
		return new Intl.NumberFormat(undefined, opts).format(n);
	}
}

/**
 * One figure to ONE decimal place, with the reader's decimal separator: 3.4 → "3.4" (en) · "3,4"
 * (nl/de/fr/es/pl). `demoDuration`'s seconds bucket is the only caller today.
 *
 * ⛔ NOT `n.toFixed(1)` AND NOT `num()`. `toFixed` is the defect — it hard-codes '.', which is the
 * THOUSANDS separator in half these catalogs. `num()` is the wrong tool the other way: its default
 * `maximumFractionDigits` is 3, so 3.0 would print as "3" and the "1.2s vs 1.9s are visibly
 * different demos" argument in `demoDuration`'s header quietly stops holding at every round tenth.
 * Both bounds are pinned explicitly so the trailing zero survives.
 *
 * Same malformed-tag fallback as `num`, for the same reason: an `Intl` `RangeError` unmounts the
 * screen, and a figure punctuated in the wrong language does not.
 */
export function decimal1(n: number, locale: string): string {
	return fixed(n, locale, 1);
}

/**
 * The same, to TWO places: `ms()`'s seconds bucket is the only caller. Two rather than one because
 * a P95 latency of 2.47 s and 2.42 s are different answers to "are we above the 2.0 s target?",
 * and the target itself is quoted beside it in `ops_alert_high_latency_detail`.
 */
export function decimal2(n: number, locale: string): string {
	return fixed(n, locale, 2);
}

/**
 * A FRACTION as a reader's percentage: `0.86` → "86%" (en/nl/he) · "86 %" (de/fr/es) ·
 * "86\u200E%\u200E" (ar).
 *
 * ⛔ THE ARGUMENT IS A FRACTION, NOT A PERCENTAGE — `pct(0.86)`, never `pct(86)`. `Intl`'s
 * `style: 'percent'` multiplies by 100 itself, so handing it an already-scaled value silently
 * renders 8,600%. The name is short because the call sites are, and this line is the whole
 * contract: it takes what a confidence/ratio field actually holds.
 *
 * ⛔ WHY `style: 'percent'` AND NOT `num(x * 100, locale) + '%'`. The percent sign is not a
 * character you append — its FORM, its SPACING and its BIDI MARKS are locale data, and gluing '%'
 * into a template hard-codes the English answer for every reader. Measured on Node 25 / ICU 78,
 * `0.855` at `maximumFractionDigits: 0`:
 *
 *     en, nl, he, pl   "86%"                    ← identical to the naive string
 *     de, fr, es       "86\u00A0%"                 ← NO-BREAK SPACE before the sign
 *     ar               "86\u200E%\u200E"              ← LEFT-TO-RIGHT MARKs bracketing the sign
 *
 * The `ar` row is the one that matters and the one a template cannot reproduce: without those
 * U+200E marks the '%' is a neutral character sitting between a Latin digit run and Arabic text,
 * so UAX#9 resolves it to the RTL base level and moves it to the WRONG SIDE of the number. This is
 * the same class of defect as the unisolated block slug in `api/error-message.ts` — a neutral with
 * no directional anchor — and `Intl` is the thing that already knows the answer.
 *
 * ⚠️ IT ALSO ROUNDS THE DECIMAL, NOT THE FLOAT. `Math.round(x * 100)` rounds AFTER a binary
 * multiply that is not exact, so the two can disagree at a half-way value; `Intl` rounds the
 * decimal value it was given. Not the reason this exists, but it is a second way the naive
 * spelling is not merely unlocalized.
 *
 * ⚠️ DIGITS DEFAULT TO 0, matching every call site's `Math.round`, and BOTH bounds are pinned so a
 * caller asking for one decimal keeps its trailing zero — the reason `fixed()` below exists.
 *
 * Same non-number guard and malformed-tag fallback as `num`, for the reasons documented there.
 */
export function pct(fraction: number, locale: string, digits = 0): string {
	if (typeof fraction !== 'number') return fraction == null ? '—' : String(fraction);
	const opts: Intl.NumberFormatOptions = {
		style: 'percent',
		minimumFractionDigits: digits,
		maximumFractionDigits: digits,
		...LATN
	};
	try {
		return new Intl.NumberFormat(locale, opts).format(fraction);
	} catch {
		return new Intl.NumberFormat(undefined, opts).format(fraction);
	}
}

/**
 * BOTH bounds pinned, so the trailing zero survives — that is the whole reason these exist rather
 * than `num()`, whose default `maximumFractionDigits` is 3 and minimum 0.
 *
 * Same non-number guard as `num()`, for the same measured reason: the `catch` calls
 * `toLocaleString` on the same value, so for a non-number it re-throws instead of falling back.
 */
function fixed(n: number, locale: string, digits: number): string {
	if (typeof n !== 'number') return n == null ? '—' : String(n);
	const opts = { minimumFractionDigits: digits, maximumFractionDigits: digits, ...LATN };
	try {
		return n.toLocaleString(locale, opts);
	} catch {
		return n.toLocaleString(undefined, opts);
	}
}

/**
 * The single place a `Date` meets a locale. Private: callers use the three named helpers below, so
 * that WHICH shape a surface renders stays a decision in this file and not a bag of `Intl` options
 * copy-pasted between four components (which is how three of them ended up with `[]` and the
 * fourth with `undefined`).
 *
 * ⛔ THE INVALID-DATE BRANCH IS LOAD-BEARING, AND IT IS A REAL BEHAVIOUR CHANGE. `new Date('x')
 * .toLocaleDateString()` returns the string "Invalid Date"; `Intl.DateTimeFormat.format` on the
 * same value THROWS `RangeError: Invalid time value`. Swapping one for the other without this
 * guard would convert a bad chart tooltip into a blank screen. '—' is the sentinel `timeAgo()` and
 * `ms()` in this same module already use for "no figure", so the surfaces stay consistent.
 */
function dateParts(
	value: string | number | Date,
	locale: string,
	opts: Intl.DateTimeFormatOptions
): string {
	const d = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(d.getTime())) return '—';
	// The digits inside a date are pinned for the same reason the digits inside a figure are — see
	// the LATN block at the top of this file. `ar` writes the day and year with whichever numbering
	// system the runtime's CLDR happens to default to, so '7 أغسطس 2026' and '٧ أغسطس ٢٠٢٦' are the
	// same call on two ICU builds.
	const pinned: Intl.DateTimeFormatOptions = { ...opts, ...LATN };
	try {
		return new Intl.DateTimeFormat(locale, pinned).format(d);
	} catch {
		return new Intl.DateTimeFormat(undefined, pinned).format(d);
	}
}

/**
 * A clock time on a chart axis: "14:30" (nl/de/fr/pl/he) · "02:30 PM" (en) · "02:30 م" (ar).
 *
 * ⚠️ 12-HOUR IN ENGLISH IS THE CORRECT ANSWER, NOT A LEFTOVER. The it-dash sparkline showed AM/PM
 * to every reader because it asked the runtime; it now shows AM/PM only to readers whose locale
 * uses it. Do NOT "fix" that by passing `hour12: false` — that re-hard-codes one convention for
 * all eight locales, which is the shape of the bug this function replaced.
 */
export function hourMinute(value: string | number | Date, locale: string): string {
	return dateParts(value, locale, { hour: '2-digit', minute: '2-digit' });
}

/**
 * A day inside a chart, no year: "Aug 7" (en) · "7 aug" (nl) · "7. Aug." (de) · "7 באוג׳" (he).
 *
 * `timeZone` is explicit rather than defaulted because the two call sites genuinely differ and
 * getting it wrong shifts every label by a day. /usage buckets on `date_trunc('day', …)` in the
 * DB's UTC session and ships `…T00:00:00.000Z`, so it MUST format in UTC or a reader at a negative
 * offset sees yesterday's date over today's number. block-edit's usage trend hands over a bare
 * `YYYY-MM-DD` that `new Date()` parses as LOCAL midnight, so it must NOT.
 */
export function dayMonth(
	value: string | number | Date,
	locale: string,
	timeZone?: string
): string {
	return dateParts(value, locale, { month: 'short', day: 'numeric', ...(timeZone ? { timeZone } : {}) });
}

/**
 * A month as a name: "October 2026" (en) · "oktober 2026" (nl) · "Oktober 2026" (de). UTC, because
 * a period starts at 00:00 UTC on the 1st and a reader west of UTC would otherwise see the month
 * before. Month names are not product copy — `Intl` carries them for every catalog locale.
 */
export function monthYear(value: string | number | Date, locale: string): string {
	return dateParts(value, locale, { year: 'numeric', month: 'long', timeZone: 'UTC' });
}

/**
 * A period BOUNDARY as a date: "November 1, 2026" (en) · "1 november 2026" (nl). UTC, because every
 * cycle boundary is 00:00 UTC — formatted in a reader's local zone west of UTC it would name the day
 * BEFORE the switch (Oct 31 for a Nov 1 switch).
 */
export function boundaryDate(value: string | number | Date, locale: string): string {
	return dateParts(value, locale, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/**
 * A phase-boundary INSTANT in the reader's own timezone, with its weekday: "Fri 02:00" (nl reader in
 * CEST for a Fri 00:00 UTC close) · "Thu 20:00" (a reader in New York). The weekday is part of the
 * claim: the same instant is a different calendar day either side of UTC. `timeZone` is a test seam.
 */
export function weekdayTime(value: string | number | Date, locale: string, timeZone?: string): string {
	return dateParts(value, locale, {
		weekday: 'short',
		hour: '2-digit',
		minute: '2-digit',
		...(timeZone ? { timeZone } : {})
	});
}

/** A dated fact in prose: "Aug 7, 2026" (en) · "7 aug 2026" (nl). `null` → '—'. */
export function fullDate(value: string | number | Date | null, locale: string): string {
	if (value === null) return '—';
	return dateParts(value, locale, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Mem cap as "1.2 GB" · "1,2 GB" (live usage isn't metered — see S4 non-guarantees).
 *
 * ⛔ THE THIRD `toFixed` IN THIS MODULE, AND IT WAS FOUND BY A GUARD RATHER THAN BY READING.
 * `demoDuration` (fixed with `decimal1`), `ms` and this one were the same one-line defect: a
 * hard-coded '.' decimal separator, which six of the eight catalogs write as ','. Both call sites
 * are in `routes/sandboxes/+page.svelte`, and one of them is the table cell IMMEDIATELY ABOVE
 * `{num(s.llmCallsToday, locale.current)}` — so a Dutch reader had a correctly-grouped figure and
 * an incorrectly-punctuated one in adjacent columns of one row.
 *
 * `decimal1` rather than `toFixed(1)` for the reason that helper exists: it keeps BOTH bounds
 * pinned, so a whole-gigabyte cap still reads "2,0 GB" and not "2 GB".
 */
export function gb(mb: number, locale: string): string {
	return `${decimal1(mb / 1000, locale)} GB`;
}

/**
 * A byte size for a human: `378 B` · `1,2 KB` (nl) · `1.2 KB` (en) · `3,4 MB` (de).
 *
 * ⛔ THIS LIVED IN `/datasets` AS A LOCAL `fmtBytes` AND HARD-CODED THE DECIMAL SEPARATOR:
 * `` `${(b / 1024).toFixed(1)} KB` ``. Measured on the running app in Dutch, the dataset table read
 * **`1.2 KB`** — which a Dutch reader parses as *twelve hundred* — in a column beside a row count
 * rendered `1.207` by `num()`. Two different meanings for `.` in one table.
 *
 * It sat outside `lib/utils/format.ts`, which is exactly why the `.toFixed(` guard never saw it:
 * that assertion read this file and only this file. Moving it here is half the fix; widening the
 * guard to the whole tree is the other half.
 *
 * ⚠️ THE UNIT IS CONCATENATED IN CODE, DELIBERATELY — same rule as `gb()` directly above, and NOT a
 * catalog message. `B`/`KB`/`MB` do not inflect in any of the eight locales, so three keys × eight
 * catalogs would be 24 strings whose values are byte-identical, and "a message key whose eight
 * values are byte-identical claims a translation decision nobody made".
 *
 * ⚠️ 1024, NOT 1000 — this measures a stored payload (`datasets.size_bytes`), where the binary step
 * is what the operator's other tools report. `gb()` divides by 1000 because it converts a memory
 * figure the backend has already expressed in MB; the two are not inconsistent, they are different
 * conversions. Whole bytes below 1 KB: `378,0 B` would imply a precision that does not exist.
 */
export function bytes(b: number, locale: string): string {
	// Same rule as `usd`, plus NaN/∞: `NaN < 1024` is false, so an un-guarded NaN fell through to
	// the MB branch and rendered "NaN MB" ("ليس رقمًا MB" in ar). A size that is not a size is '—'.
	if (typeof b !== 'number' || !Number.isFinite(b)) return '—';
	if (b < 1024) return `${num(b, locale)} B`;
	if (b < 1024 * 1024) return `${decimal1(b / 1024, locale)} KB`;
	return `${decimal1(b / (1024 * 1024), locale)} MB`;
}
