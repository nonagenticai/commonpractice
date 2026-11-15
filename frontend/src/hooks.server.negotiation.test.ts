// src/hooks.server.negotiation.test.ts — the shell's `<html lang dir>` is decided by the SAME rules
// the backend uses to pick a response language, and no `%cp.` placeholder ever reaches a browser.
//
// ⛔ THE DEFECT THE HOOK FIXES is written out at length in `src/hooks.server.ts`: `app.html`
// hardcoded `lang="en" dir="ltr"`, and the real values were applied a full render later by
// `applyDocument()` in `$lib/stores/locale.svelte.ts`. Every `ar`/`he` reader painted the whole
// chrome left-to-right and watched it flip, and every screen reader was told "English" at parse time
// — an attribute it does not re-read because a store mutated it afterwards.
//
// ⛔ WHY NEGOTIATION IS TESTED AS A UNIT AND IN THIS MUCH DETAIL. `parseAcceptLanguage` is a
// DELIBERATE MIRROR of `parseAcceptLanguage` in `backend/src/utils/locale.ts` — two packages, no
// shared module. The thing worse than duplicated negotiation is negotiation that DISAGREES: the shell
// would declare `lang="de"` while `/api/*` answered the same request in French, and the page would be
// self-contradictory in a way no end-to-end test asserts on. Each case below pins one of the rules
// that header parsing gets wrong by default, and every one of them is a rule someone would "simplify"
// away as an edge case:
//
//   • an ABSENT `q` is 1.0, the HIGHEST weight — the naive `Number(q ?? 0)` ranks it last
//   • `q=0` is a REFUSAL and is dropped, not sorted to the bottom, so it can never be selected
//   • an UNREADABLE `q` is not-sent, i.e. 1.0 — `Number('abc')` is `NaN`, which poisons every sort
//     comparison it touches and silently randomises the whole ranking
//   • an unsupported tag is WALKED PAST, not stopped on — `xx,nl` must find `nl`
//   • a region subtag reduces to its base — `nl-BE` is a Dutch reader
//
// ⚠️ THE HOOK HALF IS NOT A FORMALITY. `transformPageChunk` is the only thing standing between
// `app.html` and the wire. If it stopped firing, or fired on one placeholder and not the other, the
// document ships a LITERAL `lang="%cp.lang%"` — an invalid language tag, which is strictly worse than
// the wrong-but-valid `lang="en"` the hook replaced. That case has its own test, driven against the
// REAL `src/app.html` on disk rather than a hand-typed copy, because a hand-typed copy cannot notice
// that someone renamed the placeholder in the shell and not in the hook.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { locales, baseLocale } from '$lib/paraglide/runtime';
import { resolveShellLocale, handle } from './hooks.server';

describe('resolveShellLocale: the cookie decides, and only then the header', () => {
	it('a supported cookie beats the header outright', () => {
		// Cookie-before-header mirrors paraglide's own client strategy order (minus the `localStorage`
		// step no server can read), so the shell agrees with what the client is about to resolve. If
		// the header won, a reader who explicitly switched to German would get a Dutch first paint on
		// every navigation and see it corrected on mount — the flicker the hook exists to remove.
		expect(resolveShellLocale('de', 'nl,fr')).toBe('de');
	});

	it.each([
		['an unsupported cookie', 'xx'],
		['an absent cookie', null],
		['an empty cookie', ''],
		['an undefined cookie', undefined]
	])('%s falls through to the header rather than winning', (_label, cookie) => {
		// ⚠️ The empty-string case is the one that gets lost in a refactor: `cookie ?? header` and
		// `if (cookie)` disagree about `''`, and `''` is exactly what a failed `pgSetLocale()` write
		// leaves behind. An empty cookie must not select `baseLocale` while the client, reading the
		// same empty value, moves on to `preferredLanguage`.
		expect(resolveShellLocale(cookie, 'pl')).toBe('pl');
	});

	it('a cookie naming a region-qualified tag is not accepted', () => {
		// The cookie arm is exact membership, deliberately: paraglide's client runtime resolves the
		// cookie the same way, so accepting `nl-BE` here would make the server declare a locale the
		// browser is about to reject and replace. Falling through to the header keeps the two agreeing.
		expect(resolveShellLocale('nl-BE', 'de')).toBe('de');
	});
});

describe('resolveShellLocale: q-value rules, each one a decision and not a default', () => {
	it('⛔ an absent q means 1.0 — the HIGHEST weight, not the lowest', () => {
		// `de,nl;q=0.9` is a client saying "German, or Dutch if you must". A parser that defaults a
		// missing q to 0 (or to `Number(undefined)` → NaN) serves Dutch to a German reader, and it does
		// so on the most common header shape there is.
		expect(resolveShellLocale(null, 'de,nl;q=0.9')).toBe('de');
	});

	it('⛔ q=0 is an explicit refusal and is DROPPED, not ranked last', () => {
		// Sorting a refusal to the bottom looks equivalent and is not: the moment nothing else in the
		// header is supported, "ranked last" becomes "selected". Both halves are asserted — the entry
		// loses to a real preference, AND on its own it cannot win.
		expect(resolveShellLocale(null, 'nl;q=0,de')).toBe('de');
		expect(resolveShellLocale(null, 'nl;q=0')).toBe(baseLocale);
		expect(resolveShellLocale(null, 'nl;q=0')).toBe('en');
	});

	it.each([
		['non-numeric', 'nl;q=abc'],
		['empty', 'nl;q='],
		['negative', 'nl;q=-1'],
		['whitespace only', 'nl;q= ']
	])('⛔ an unreadable q (%s) is treated as not-sent → 1.0', (_label, header) => {
		// The client demonstrably LISTED the language; only the strength is unreadable, and 0 is
		// reserved for the one spelling that means refusal. The alternative — `Number('abc')` → NaN —
		// is worse than picking a wrong locale: every `a.q - b.q` comparison involving NaN returns NaN,
		// so the sort's result becomes engine-dependent and the whole ranking is silently arbitrary.
		expect(resolveShellLocale(null, header)).toBe('nl');
	});

	it('⛔ the ranking is by weight, not by source order', () => {
		// The listed order here is fr, he, de and the correct answer is the middle one. A parser that
		// forgot to sort, or that sorted ascending, returns `fr` or `de` — and both look plausible
		// enough in a review to survive it.
		expect(resolveShellLocale(null, 'fr;q=0.3,he;q=0.8,de;q=0.5')).toBe('he');
	});

	it('ties keep source order', () => {
		// Equal weights must resolve to the first one WRITTEN. `Array#sort` is only specified as stable
		// since ES2019 and the implementation carries an explicit `order` tiebreaker rather than
		// trusting it; this is the assertion that says the tiebreaker is wired up and pointing forwards.
		expect(resolveShellLocale(null, 'de;q=0.5,nl;q=0.5')).toBe('de');
		expect(resolveShellLocale(null, 'nl;q=0.5,de;q=0.5')).toBe('nl');
	});
});

describe('resolveShellLocale: tags this product does not ship', () => {
	it('⛔ an unsupported tag is walked past, not stopped on', () => {
		// The loop must keep scanning. Returning `baseLocale` the moment the FIRST entry misses is the
		// natural way to write this and it is wrong for every reader whose browser leads with a tag we
		// do not ship — which is most readers with more than one language configured.
		expect(resolveShellLocale(null, 'xx,nl')).toBe('nl');
		expect(resolveShellLocale(null, 'xx,yy,zz,he')).toBe('he');
	});

	it.each([
		['nl-BE', 'nl-BE', 'nl'],
		['ar-EG', 'ar-EG', 'ar'],
		['de-AT;q=0.9,xx', 'de-AT;q=0.9,xx', 'de']
	])('a region subtag reduces to its base: %s', (_label, header, expected) => {
		// Browsers overwhelmingly send region-qualified tags. Exact matching on the header would make
		// the negotiator dead code for the majority of real requests while passing every test written
		// with bare tags.
		expect(resolveShellLocale(null, header)).toBe(expected);
	});

	it('an unsupported BASE is unsupported however it is qualified', () => {
		// The mirror of the case above, and the reason the reduction is not simply "strip and accept":
		// `pt-BR` reduces to `pt`, which this product does not ship, so it must fall through.
		expect(resolveShellLocale(null, 'pt-BR')).toBe('en');
		expect(resolveShellLocale(null, 'pt-BR,he')).toBe('he');
	});

	it('⛔ `*` matches nothing', () => {
		// A wildcard is a client saying "anything"; the correct reading of "anything" is `baseLocale`,
		// reached by the SAME path as any other unsupported tag. A parser that special-cased `*` into
		// "the first supported locale" would make `*` mean `en` by accident of list order.
		expect(resolveShellLocale(null, '*')).toBe('en');
		expect(resolveShellLocale(null, '*;q=0.5,he')).toBe('he');
	});

	it.each([
		['an absent header', null],
		['an empty header', ''],
		['a header of separators only', ',,'],
		['a header of whitespace', '   ']
	])('%s falls through to baseLocale', (_label, header) => {
		// `''.split(',')` is `['']`, not `[]` — an empty header still produces one loop iteration, and
		// a parser that pushed that empty tag would rank a `''` base ahead of everything after it.
		expect(resolveShellLocale(null, header)).toBe(baseLocale);
		expect(resolveShellLocale(null, header)).toBe('en');
	});
});

describe('resolveShellLocale: header syntax is case-insensitive', () => {
	it('the language tag is lowercased', () => {
		// `Accept-Language` tags are case-insensitive per RFC and real clients do send `en-GB`, `zh-Hant`
		// casing. A case-sensitive `includes()` against the compiled list — which is all-lowercase —
		// silently drops them and every such reader gets `baseLocale`.
		expect(resolveShellLocale(null, 'DE')).toBe('de');
		expect(resolveShellLocale(null, 'NL-be')).toBe('nl');
		expect(resolveShellLocale(null, 'Ar-EG')).toBe('ar');
	});

	it('⛔ the `q` PARAMETER NAME is matched case-insensitively', () => {
		// Stated as a discriminating case rather than a presence check: `de;Q=0.9,nl` must resolve to
		// `nl`, because `de` was explicitly weakened. If `Q` were not recognised, `de` would keep its
		// default 1.0 and win on source order — so the assertion FAILS to `de` and names the bug,
		// instead of passing for the wrong reason the way `'de;Q=0.9'` alone would.
		expect(resolveShellLocale(null, 'de;Q=0.9,nl')).toBe('nl');
		expect(resolveShellLocale(null, 'nl;Q=0,de')).toBe('de');
	});
});

describe('resolveShellLocale: every locale the product ships is reachable', () => {
	// ⭐ THE COVERAGE GUARD. Every other case in this file names two or three locales by hand, which
	// means a NINTH locale could be added to `messages/` and be unreachable through both arms of the
	// resolver with the whole suite green. This loops the GENERATED list, so locale nine is covered
	// the moment it compiles — and if it is unreachable (a typo in a catalog filename, a locale the
	// paraglide compiler emitted but the cookie arm rejects) this is the test that says which one.
	it.each([...locales])('%s is selectable by header and by cookie', (locale) => {
		expect(resolveShellLocale(null, locale), `${locale} is unreachable via Accept-Language`).toBe(
			locale
		);
		expect(resolveShellLocale(locale, 'zz'), `${locale} is unreachable via the cookie`).toBe(locale);
	});

	it('the loop above ran against a real locale list', () => {
		// NON-VACUITY. `it.each([])` registers ZERO tests and reports a clean run, which is the failure
		// mode a generated import invites — the guard above would be entirely absent and nothing would
		// say so.
		expect(locales.length).toBe(8);
	});
});

/** The shape `handle` is actually called with, so the fakes below can be cast once and named here. */
type HandleArg = Parameters<typeof handle>[0];

/**
 * Drive the real `handle` with a fake `event`/`resolve`, capture the `transformPageChunk` it hands
 * to SvelteKit, and run `html` through it. Nothing is mocked but the platform.
 */
async function stampShell(cookieLocale: string | null, html: string): Promise<string> {
	let transform: ((chunk: { html: string; done: boolean }) => string) | undefined;
	const event = {
		cookies: { get: () => cookieLocale },
		request: { headers: { get: () => null } }
	};
	const resolve = (
		_event: unknown,
		opts?: { transformPageChunk?: (chunk: { html: string; done: boolean }) => string }
	) => {
		transform = opts?.transformPageChunk;
		// ⚠️ A REAL `Headers`, not `{ status: 200 }`. `handle` appends `Vary` to the resolved
		// response, so a fake without headers makes every test here die on `undefined.append` —
		// which reports as a broken hook rather than a broken fake. Using the platform `Headers`
		// also means the `Vary` assertions below exercise real append-vs-set semantics.
		return new Response(null, { status: 200 });
	};
	const response = (await handle({ event, resolve } as unknown as HandleArg)) as Response;
	// ⛔ The shell is per-reader now; without `Vary` a shared cache upstream (Cloudflare →
	// cloudflared → istio) may serve one reader's stamped shell to another. Asserted on every
	// stamped response rather than once, because the header is what makes the stamping safe.
	expect(response.headers.get('Vary') ?? '', 'stamped shell must not be cached as shared').toMatch(
		/Cookie/i
	);
	expect(response.headers.get('Vary') ?? '').toMatch(/Accept-Language/i);
	// ⛔ NON-VACUITY, FIRST: a `handle` that stopped passing `transformPageChunk` at all would leave
	// `transform` undefined, and an assertion on `undefined?.(…)` would report a confusing TypeError
	// instead of the actual regression — the shell is no longer being transformed.
	expect(transform, 'handle() did not pass a transformPageChunk to resolve()').toBeTypeOf('function');
	return transform!({ html, done: true });
}

const SHELL = '<html lang="%cp.lang%" dir="%cp.dir%">';

describe('handle stamps the document element before a byte of JavaScript runs', () => {
	it('⛔ an `ar` cookie yields lang="ar" dir="rtl"', () => {
		// The whole point of the hook, in one assertion. The layout is built on logical CSS properties
		// (`margin-inline`, `inset-inline`, `text-align: start`), which resolve against `dir` — so with
		// `dir="ltr"` in the shell they ALL resolve the wrong way until the store corrects it on mount.
		// The reflow is the entire page, not a detail.
		return expect(stampShell('ar', SHELL)).resolves.toBe('<html lang="ar" dir="rtl">');
	});

	it('an `de` cookie yields lang="de" dir="ltr"', () => {
		// The negative half. Without it, a `dirFor` that returned `'rtl'` unconditionally would pass the
		// case above and mirror the chrome for the six LTR locales — a failure that is invisible to the
		// only reviewer likely to look, a sighted reader of an LTR locale.
		return expect(stampShell('de', SHELL)).resolves.toBe('<html lang="de" dir="ltr">');
	});

	it('⛔ NO `%cp.` placeholder survives, for any of the eight locales', async () => {
		// ⚠️ THIS IS THE "WORSE THAN THE ORIGINAL BUG" CASE. `lang="%cp.lang%"` is not a wrong language
		// tag, it is an INVALID one: the parser cannot map it to any language, so assistive technology
		// falls back to the user-agent default and `:lang()` selectors stop matching entirely. The hook
		// therefore replaces both placeholders on EVERY response, including the arm where the resolved
		// locale is already `baseLocale` — there is no early return, and this is the assertion that
		// forbids one from being added back as an "optimisation".
		//
		// ⛔ DRIVEN AGAINST THE REAL `src/app.html`, not a hand-typed copy. A copy cannot notice that
		// someone renamed the placeholder in the shell and not in the hook, which is the single most
		// likely way this ships broken.
		const appHtml = readFileSync(fileURLToPath(new URL('./app.html', import.meta.url)), 'utf8');
		// NON-VACUITY: if the shell no longer CONTAINS the placeholders, every assertion below is
		// trivially satisfied and this file would report that a deleted feature works.
		expect(appHtml, 'src/app.html no longer declares %cp.lang%').toContain('%cp.lang%');
		expect(appHtml, 'src/app.html no longer declares %cp.dir%').toContain('%cp.dir%');

		for (const locale of locales) {
			const out = await stampShell(locale, appHtml);
			expect(out, `${locale}: a %cp. placeholder reached the browser`).not.toContain('%cp.');
			expect(out, `${locale}: lang was not stamped`).toContain(`lang="${locale}"`);
			expect(out, `${locale}: dir was not stamped`).toMatch(/dir="(rtl|ltr)"/);
		}
		// …and the two RTL locales really did take the rtl arm, so the loop above is not passing
		// because everything is uniformly `ltr`.
		expect(await stampShell('he', SHELL)).toContain('dir="rtl"');
		expect(await stampShell('ar', SHELL)).toContain('dir="rtl"');
	});

	it('a request with neither cookie nor header still stamps a valid shell', () => {
		// The `baseLocale` arm, asserted explicitly because it is the one a short-circuit would skip.
		return expect(stampShell(null, SHELL)).resolves.toBe('<html lang="en" dir="ltr">');
	});
});
