// src/utils/untrusted-text.ts — one-line, printable text from a stranger.
//
// Early-access signups put requester-typed `name` / `company` into a Telegram message George acts
// on. A newline, a bidi override or a zero-width character in those fields let a requester forge
// whole lines of that message ("Verified: yes", a fake "Signup id:") or visually reorder it. So the
// fields are normalised at INPUT VALIDATION (the stored value is already clean) and again at render
// (services/signup-telegram.ts), because rows written by other paths reach the notifier too.
import { z } from 'zod';

// Cc = C0/C1 controls (incl. \t \n \r, DEL), Zl/Zp = U+2028/U+2029 line/paragraph separators: all
// become a SPACE, so "Ann\nEvil" reads as "Ann Evil" rather than fusing two words.
const BREAKING = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
// Cf = format characters: bidi embeddings/overrides/isolates (U+202A–202E, U+2066–2069), LRM/RLM,
// zero-width space/joiners, BOM, soft hyphen, tag characters. Invisible by design, so removed.
const INVISIBLE = /\p{Cf}/gu;
// Unicode-aware whitespace (incl. NBSP, ideographic space) collapses to one ASCII space.
const SPACES = /[\s\p{Zs}]+/gu;

/** Strip control/format characters, collapse whitespace, trim. Never returns a line break. */
export function singleLine(value: string): string {
  return value.replace(BREAKING, ' ').replace(INVISIBLE, '').replace(SPACES, ' ').trim();
}

/**
 * Zod schema for a requester-typed single-line field: normalised by `singleLine`, then
 * `1..max` characters. An input that is EMPTY AFTER STRIPPING (only spaces / controls / bidi marks)
 * is refused like an empty one. `rawMax` bounds the pre-normalisation input so a huge body of
 * invisible characters is rejected before any regex runs over it.
 */
export function singleLineText(max: number, rawMax = max * 4) {
  return z.string().max(rawMax).transform(singleLine).pipe(z.string().min(1).max(max));
}

// Multi-line variant. Line breaks are kept (as `\n`) — the text is shown with preserved line breaks
// on /onboarding — but every OTHER control character, line/paragraph separator and format character
// goes: CRLF / CR / U+2028 / U+2029 become `\n`, a tab becomes a space, the remaining Cc are
// removed, and Cf (bidi overrides, zero-width characters) are removed as in `singleLine`.
const NEWLINES = /\r\n?|[\p{Zl}\p{Zp}]/gu;
const CONTROLS_BUT_NEWLINE = /[^\P{Cc}\n]/gu;

/** Strip control/format characters except `\n`, normalise line endings, trim. */
export function multiLine(value: string): string {
  return value
    .replace(NEWLINES, '\n')
    .replace(/\t/g, ' ')
    .replace(CONTROLS_BUT_NEWLINE, '')
    .replace(INVISIBLE, '')
    .trim();
}

/**
 * Zod schema for a requester-typed multi-line field: normalised by `multiLine`, then `0..max`
 * characters. Empty after stripping becomes `undefined` (the field was effectively not given).
 * `rawMax` bounds the pre-normalisation input, as in `singleLineText`.
 */
export function multiLineText(max: number, rawMax = max * 4) {
  return z
    .string()
    .max(rawMax)
    .transform(multiLine)
    .pipe(z.string().max(max))
    .transform((v) => (v === '' ? undefined : v));
}
