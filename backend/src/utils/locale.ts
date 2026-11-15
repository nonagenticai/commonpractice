// src/utils/locale.ts — §5B locale support. The 8 book-edition locales and a
// minimal Accept-Language negotiator. Keep this list in sync with the frontend
// Paraglide `locales` (project.inlang/settings.json) and the seeded prompts.
export const SUPPORTED_LOCALES = [
  'en',
  'nl',
  'pl',
  'fr',
  'es',
  'de',
  'ar',
  'he',
] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

export function isSupportedLocale(value: unknown): value is Locale {
  return (
    typeof value === 'string' &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

/** One parsed `Accept-Language` entry: its base language subtag and its weight. */
interface WeightedTag {
  /** The primary subtag, lower-cased — `nl` for `nl-NL`. */
  base: string;
  /** The q-value, 0 < q <= 1. Entries with q=0 never reach this list. */
  q: number;
  /** Position in the header, kept so ties resolve to source order. */
  order: number;
}

/**
 * A q-value as RFC 9110 §12.4.2 spells it: digits, optionally a fractional part. Deliberately NOT
 * `Number(raw)`, which accepts things a header never legitimately contains and — the trap that
 * matters — turns the EMPTY string into `0`, i.e. reads the malformed `q=` as the one value that
 * means "explicitly not acceptable" and silently drops a language the client did ask for.
 */
const Q_VALUE_RE = /^\d+(?:\.\d+)?$/;

/**
 * Parse `Accept-Language` into supported-or-not base tags, ORDERED BY PREFERENCE.
 *
 * ⛔ THIS ORDERING IS THE POINT, AND ITS ABSENCE WAS A LIVE BUG. Until migration 0081 this parser
 * read the header in SOURCE order and returned the first supported tag, ignoring `q` entirely — so
 * `nl;q=0.1,de;q=0.9` resolved to `nl`, the language the client ranked LAST. That went unnoticed
 * because the two populations that reach it both hid it: `/api/me` never got here at all (the
 * `users.locale` column was NOT NULL DEFAULT 'en', so the stored-preference branch always won —
 * see 0081), and the other fourteen call sites are all `negotiateLocale(req)` from the SPA, whose
 * `authFetch` sets `Accept-Language` to a SINGLE bare tag (`getLocale()`, api/auth-fetch.ts) that
 * has no `q` to mis-rank. 0081 made `/api/me` reach this code for every user who has never chosen
 * a locale, on a header the BROWSER wrote — which is exactly the header that carries q-values.
 * Making dead code reachable is a behaviour change; this is the other half of that change.
 *
 * THE RULES, each one a decision rather than a default:
 *
 *  • **An absent `q` means 1.0 — the HIGHEST weight, not the lowest.** `de,nl;q=0.9` prefers `de`.
 *    Getting this backwards is the tempting bug, because "no q" reads like "no opinion".
 *  • **`q=0` means "explicitly not acceptable"** and the entry is DROPPED, not merely ranked last.
 *    `nl;q=0` must fall through to the next candidate — treating it as a weak preference would let
 *    a client's explicit refusal select the very language it refused.
 *  • **A `q` we cannot read is a `q` that was not sent** (`q=abc`, `q=`, `q=-1` → 1.0). The client
 *    demonstrably listed the language; the only unreadable part is how strongly. Downgrading it to
 *    0 would silently discard a stated language over a typo, and 0 is reserved for the one spelling
 *    that means refusal. This is a judgement call and it is the lenient one on purpose.
 *  • **Ties keep source order**, via the explicit `order` tiebreaker below rather than by trusting
 *    `Array.prototype.sort` to be stable. It is (ES2019), but a load-bearing ordering rule should
 *    be readable in this file instead of inferred from the spec.
 *  • **`*` matches nothing.** It parses to the base tag `*`, which is not in SUPPORTED_LOCALES, so
 *    it is skipped like any other unsupported tag and `*` alone falls through to DEFAULT_LOCALE.
 *    Resolving the wildcard to "any locale we have" would hand an arbitrary language to a client
 *    that expressed no preference at all.
 *
 * Unsupported tags are KEPT in the list rather than filtered here, so `xx,nl` walks past `xx` and
 * finds `nl` instead of stopping. The supported-ness test stays with the caller, which owns it.
 */
function parseAcceptLanguage(header: string): WeightedTag[] {
  const tags: WeightedTag[] = [];
  for (const part of header.split(',')) {
    const segments = part.split(';');
    const tag = segments[0]?.trim().toLowerCase() ?? '';
    if (!tag) continue;
    let q = 1;
    for (const segment of segments.slice(1)) {
      const eq = segment.indexOf('=');
      if (eq < 0 || segment.slice(0, eq).trim().toLowerCase() !== 'q') continue;
      const raw = segment.slice(eq + 1).trim();
      q = Q_VALUE_RE.test(raw) ? Number(raw) : 1;
      break;
    }
    if (q === 0) continue; // an explicit refusal, not a weak preference
    tags.push({ base: tag.split('-')[0] ?? '', q, order: tags.length });
  }
  return tags.sort((a, b) => b.q - a.q || a.order - b.order);
}

/**
 * Resolve a request's locale: an explicit stored preference wins, otherwise the
 * HIGHEST-WEIGHTED supported base tag from `Accept-Language`, else `en`.
 * (SPA first-load negotiation also happens client-side via Paraglide; this is
 * the server-side fallback for the agent + content surfaces.)
 *
 * ⚠️ `userPref` is a THREE-STATE argument since 0081, and the `null` case is the common one:
 * `users.locale` is nullable and NULL means "this person has never chosen", which is what sends
 * `routes/me.ts` into the header branch below. Before 0081 that branch was unreachable from
 * `/api/me` and a Dutch reader on a Dutch browser was served English.
 */
export function negotiateLocale(
  req: Request,
  userPref?: string | null,
): Locale {
  if (isSupportedLocale(userPref)) return userPref;
  const header = req.headers.get('accept-language') ?? '';
  for (const { base } of parseAcceptLanguage(header)) {
    if (isSupportedLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}
