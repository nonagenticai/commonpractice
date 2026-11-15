// src/hooks.server.ts — stamps `<html lang dir>` on the SHELL, before a byte of JavaScript runs.
//
// ⛔ THE DEFECT THIS FIXES. `src/app.html` hardcoded `<html lang="en" dir="ltr">`. The correct
// values were applied only after hydration, by `applyDocument()` in
// `$lib/stores/locale.svelte.ts`, which runs from `+layout.svelte`'s `onMount`. So EVERY reader of
// EVERY one of the eight locales was served a document that declared itself English and
// left-to-right, and it was corrected a full render later. Consequences, worst first:
//
//  • **`ar` and `he` paint the entire chrome left-to-right and then flip.** The layout is built on
//    logical CSS properties (`margin-inline`, `inset-inline`, `text-align: start`), which is what
//    makes the app RTL-capable at all — but logical properties resolve against `dir`, so with
//    `dir="ltr"` in the shell they ALL resolve the wrong way until the store corrects it. The
//    reflow is the whole page, not a detail.
//  • **Assistive technology and crawlers only ever see `lang="en"`.** A screen reader picks its
//    pronunciation from `<html lang>` at parse time; it does not re-read the attribute because a
//    store mutated it later. An Arabic or Polish page was being announced with English phonetics.
//  • **It was invisible in the locale we tested in.** `nl`, `de`, `fr` and `es` are LTR and their
//    `lang` mismatch is silent on screen, so a Dutch demo could not surface this. It is a
//    defect the ONLY unaffected observer is a sighted LTR reader.
//
// ⛔ WHY THIS IS A HOOK AND NOT `ssr = true`. `src/routes/+layout.ts` sets `ssr = false` because
// `keycloak-js` and the auth store are browser-only; flipping that on is a real project, not a
// line. But `adapter-node` renders the SHELL server-side on every request regardless of `ssr`, and
// `transformPageChunk` sees that shell — so the document element can be made correct WITHOUT
// touching the SPA model. Nothing here renders a component or reads a session.
//
// ⚠️ WHAT THIS CANNOT SEE, STATED PLAINLY. Paraglide's client strategy order is
// `localStorage → cookie → preferredLanguage → baseLocale`. A server sees the cookie and the
// header; it CANNOT see `localStorage`. The two agree in practice because `pgSetLocale()` writes
// both on every change, so they diverge only when a localStorage write failed (the sandboxed-iframe
// / privacy-mode case the store already guards). In that divergence the shell is briefly the
// cookie's locale and the store corrects it on mount — which is the behaviour we have today for
// everyone, now narrowed to a case that is already degraded. This hook strictly reduces the number
// of readers who get a wrong first paint; it does not claim to eliminate it.
import type { Handle } from '@sveltejs/kit/hooks';
import { locales, baseLocale, cookieName } from '$lib/paraglide/runtime';
import { dirFor, isSupportedLocale } from '$lib/i18n/direction';

/** Matches the backend's `Q_VALUE_RE` (`backend/src/utils/locale.ts`) exactly — see below. */
const Q_VALUE_RE = /^\d+(?:\.\d+)?$/;

// ⚠️ `qValue`, NOT `q`. `$lib/test/number-sites.ts` builds a GLOBAL numeric vocabulary from every
// `foo: number` declaration under `src/`, and then flags any message parameter sharing that name as
// an ungrouped number. Declaring `q: number` here therefore taught that scan that `q` is a figure,
// and `Topbar.svelte`'s `m.search_no_results({ q })` — a search QUERY — started failing the
// completeness guard in a file this change never touched. Naming the field for what it is keeps a
// one-letter identifier that means something else everywhere in web code out of that vocabulary.
type WeightedTag = { base: string; qValue: number; order: number };

/**
 * Parse `Accept-Language` into base tags, highest weight first.
 *
 * ⛔ THIS IS A DELIBERATE MIRROR of `parseAcceptLanguage` in `backend/src/utils/locale.ts`, not an
 * independent implementation. The frontend and the backend are separate packages with no shared
 * module, and the one thing worse than duplicated negotiation is negotiation that DISAGREES: the
 * shell would declare `lang="de"` while `/api/*` answered in French for the same request. The
 * rules below are copied deliberately, and `hooks.server.negotiation.test.ts` pins them against the
 * same case table the backend's own test uses, so a change on either side reddens this one.
 *
 * The rules, each a decision rather than a default:
 *  • An absent `q` means 1.0 — the HIGHEST weight. `de,nl;q=0.9` prefers `de`.
 *  • `q=0` is an explicit refusal: the entry is DROPPED, not ranked last, so `nl;q=0` can never
 *    select `nl`.
 *  • An unreadable `q` (`q=abc`, `q=`, `q=-1`) is treated as not sent → 1.0. The client
 *    demonstrably listed the language; only the strength is unreadable, and 0 is reserved for the
 *    one spelling that means refusal.
 *  • Ties keep source order, via the explicit `order` tiebreaker rather than trusting sort
 *    stability.
 *  • `*` parses to the base tag `*`, which is not a supported locale, so it is skipped and a bare
 *    `*` falls through to `baseLocale`.
 *
 * Unsupported tags are KEPT rather than filtered here, so `xx,nl` walks past `xx` and finds `nl`.
 */
function parseAcceptLanguage(header: string): WeightedTag[] {
	const tags: WeightedTag[] = [];
	for (const part of header.split(',')) {
		const segments = part.split(';');
		const tag = segments[0]?.trim().toLowerCase() ?? '';
		if (!tag) continue;
		let qValue = 1;
		for (const segment of segments.slice(1)) {
			const eq = segment.indexOf('=');
			if (eq < 0 || segment.slice(0, eq).trim().toLowerCase() !== 'q') continue;
			const raw = segment.slice(eq + 1).trim();
			qValue = Q_VALUE_RE.test(raw) ? Number(raw) : 1;
			break;
		}
		if (qValue === 0) continue; // an explicit refusal, not a weak preference
		tags.push({ base: tag.split('-')[0] ?? '', qValue, order: tags.length });
	}
	return tags.sort((a, b) => b.qValue - a.qValue || a.order - b.order);
}

// ⛔ NO LOCAL COPY OF THE SUPPORTED-LOCALE TEST. `direction.ts` exists precisely to stop this file
// and the browser store holding two versions of the same list; declaring an identical `isSupported`
// here would have re-created that split one file later.
const isSupported = (value: string | null | undefined): value is string =>
	isSupportedLocale(value);

/**
 * The locale this request's SHELL should declare: the persisted cookie wins, else the
 * highest-weighted supported tag in `Accept-Language`, else `baseLocale`.
 *
 * Cookie-before-header mirrors paraglide's own strategy order (minus the `localStorage` step no
 * server can read), so the shell agrees with what the client is about to resolve.
 */
export function resolveShellLocale(cookie: string | null | undefined, header: string | null): string {
	if (isSupported(cookie)) return cookie;
	for (const { base } of parseAcceptLanguage(header ?? '')) {
		if (isSupported(base)) return base;
	}
	return baseLocale;
}

/**
 * Browser-security response headers for the SHELL.
 *
 * ⛔ THE DEFECT THIS FIXES, MEASURED RATHER THAN ASSUMED. This app served NONE of these. That was
 * established by COMPARISON, not by reading a scanner: `x-frame-options`, `x-content-type-options`
 * and `referrer-policy` are all present on `auth.nonagentic.ai` — Keycloak sets them itself — and
 * all absent on this app, over the same Cloudflare → cloudflared → istio path. So the edge is not
 * stripping them; the origin simply never set them. (Cloudflare does supply HSTS for both, which is
 * why `strict-transport-security` is NOT in this table: it is already there, and setting it from an
 * origin that also answers on plain HTTP in dev is how you lock a developer out of localhost.)
 *
 * ⚠️ WHY THIS APP IN PARTICULAR. It is an SSO SPA. It redirects to Keycloak, comes back with an
 * OAuth `code` and `state` in the URL bar, and holds tokens in browser context. That makes two of
 * these headers load-bearing rather than hygienic — see `referrer-policy` and `x-frame-options`.
 *
 * Each entry, and why it is safe to turn on without a verification pass:
 *
 *  • `x-content-type-options: nosniff` — forbids MIME-sniffing. No behaviour change whatsoever for
 *    a server that already labels its own assets correctly, which `adapter-node` does.
 *
 *  • `referrer-policy: strict-origin-when-cross-origin` — the one that matters most here. Without
 *    it, the browser is entitled to put the FULL current URL in `Referer` on cross-origin
 *    subresource requests — and immediately after the OAuth round trip the full current URL
 *    CONTAINS the `code` and `state`. This sends the origin only, cross-origin. (This is also the
 *    modern browser default, so it changes nothing for current browsers and closes the hole on
 *    anything older or configured otherwise; either way we stop depending on a default we do not
 *    control.)
 *
 *  • `x-frame-options: SAMEORIGIN` — blocks clickjacking of the vote and leaderboard UI, where a
 *    framed page overlaid on an attacker's chrome turns a stray click into a cast vote. SAMEORIGIN
 *    rather than DENY, and it is exactly what Keycloak already sends on the auth origin, so the two
 *    halves of the login flow now agree instead of one being unprotected.
 *
 *  • `cross-origin-opener-policy: same-origin-allow-popups` — ⚠️ `-allow-popups`, DELIBERATELY, and
 *    NOT the bare `same-origin`. Bare `same-origin` severs `window.opener` for popups this document
 *    opens, which is precisely the channel a popup-based auth flow uses to hand its result back to
 *    the opener. `keycloak-js` can run that shape. The `-allow-popups` variant still isolates this
 *    document from a cross-origin OPENER — the actual XS-Leaks / Spectre concern — while keeping
 *    popups we open ourselves talking to us. Changing this to bare `same-origin` is not a
 *    tightening, it is a functional change to the login path, and needs the flow re-tested.
 *
 * ⛔ NO `Content-Security-Policy`, AND ITS ABSENCE IS A DECISION — DO NOT READ IT AS AN OVERSIGHT.
 * CSP is by a distance the highest-value header on this list, and it is exactly the one that cannot
 * be added blind: a `script-src`/`connect-src` that is even slightly wrong does not degrade the app,
 * it BREAKS it outright — a blocked bundle is a white page, a blocked `connect-src` is an SPA that
 * loads and can talk to nothing. A correct policy has to be DERIVED from this app's real origins
 * (self, the Keycloak origin `auth.nonagentic.ai` for the redirect and token endpoints, any CDN or
 * font host, and whatever inline/eval Vite and paraglide actually emit in a PRODUCTION build, which
 * is not what dev serves) and then verified against the running app — ideally shipped first as
 * `Content-Security-Policy-Report-Only` and left to collect violations before it is enforced. That
 * is a separate piece of work with its own verification, not a line in this table. The four headers
 * above were chosen because each is inert if the app is already well-behaved; CSP is not.
 *
 * ⚠️ THIS IS THE HTML SHELL ONLY, AND SOMEONE WILL EXPECT OTHERWISE. This hook runs on the
 * SvelteKit server, which serves the document and its assets. `/api/*` is PROXIED STRAIGHT TO THE
 * BACKEND (`vite.config.ts` in dev, `frontend/server.js` in production) and never passes through
 * this handle, so none of these headers appear on an API response. That is not a gap in this
 * change — these four are browser-rendering-context headers and mean nothing on a JSON response —
 * but do not go looking for them on `/api/*` and conclude the hook is broken. Backend response
 * headers are the backend's own concern.
 */
const SECURITY_HEADERS: ReadonlyArray<readonly [name: string, value: string]> = [
	['x-content-type-options', 'nosniff'],
	['referrer-policy', 'strict-origin-when-cross-origin'],
	['x-frame-options', 'SAMEORIGIN'],
	['cross-origin-opener-policy', 'same-origin-allow-popups']
];

export const handle: Handle = async ({ event, resolve }) => {
	const locale = resolveShellLocale(
		event.cookies.get(cookieName),
		event.request.headers.get('accept-language')
	);

	const response = await resolve(event, {
		// ⚠️ Both placeholders are replaced on EVERY response, including the arm where the locale is
		// `baseLocale`. Leaving a `%cp.lang%` literal in the served document would be a worse bug
		// than the one being fixed — an invalid `lang` attribute — so there is no early return.
		//
		// `replaceAll`, not `replace`: `replace` substitutes the FIRST occurrence only. Both
		// placeholders appear once in today's `app.html`, so it happens to be equivalent — but the
		// failure mode if that ever stops being true is a raw `%cp.dir%` shipped to a browser, and
		// nothing about "there is exactly one of these" is enforced anywhere.
		transformPageChunk: ({ html }) =>
			html.replaceAll('%cp.lang%', locale).replaceAll('%cp.dir%', dirFor(locale))
	});

	// ⛔ THE SHELL IS NOW PER-READER, SO IT MUST NOT BE CACHED AS IF IT WERE SHARED. This handler
	// varies the served bytes on the `PARAGLIDE_LOCALE` cookie and on `Accept-Language`. Public
	// traffic reaches this server through Cloudflare → cloudflared → istio, i.e. through caches this
	// app does not own, and a cache with no `Vary` is entitled to serve the first response it stored
	// to everyone else. That would hand an Arabic reader's `lang="ar" dir="rtl"` shell to a Dutch
	// one — the defect this file exists to fix, but promoted from "wrong for one paint" to "wrong
	// until the cache expires", and non-deterministic, which is far harder to report or reproduce.
	//
	// Set by appending rather than assigning: SvelteKit sets its own `Vary` on some responses and
	// clobbering it would trade this bug for a different one.
	response.headers.append('Vary', 'Cookie, Accept-Language');

	// ⚠️ SET-IF-ABSENT, and the choice of verb is the whole point — note that it is the OPPOSITE of
	// the `append` used for `Vary` directly above, for a reason worth stating so the two do not get
	// "made consistent" later. `Vary` is a comma-separated LIST, so appending to it composes with
	// whatever SvelteKit already put there. Every header below is a SINGLE-VALUED directive, and
	// appending to one of those does not compose — it produces `x-frame-options: DENY, SAMEORIGIN`,
	// which is not a weaker policy or a stronger one, it is a malformed value browsers may discard
	// entirely, i.e. appending would be how you turn a header that WAS working into no header at all.
	// `set` alone would be just as wrong in the other direction: it would silently overwrite a
	// stricter value deliberately set upstream (a route that sends `x-frame-options: DENY`, or an
	// edge policy) and quietly downgrade it. Guarding on `has` means this table is a FLOOR — it
	// supplies a header nobody else did, and never argues with one that is already present.
	for (const [name, value] of SECURITY_HEADERS) {
		if (!response.headers.has(name)) response.headers.set(name, value);
	}

	return response;
};
