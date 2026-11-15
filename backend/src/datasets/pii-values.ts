// src/datasets/pii-values.ts — VALUE-based personal-data detection, per cell (W8, 2026-10-15).
//
// The column-name heuristic (`isPiiName`, parse/infer.ts) only catches a column whose NAME says
// what it holds. A BSN in a column called "klant", or a phone number typed into a "notes" field,
// passes it untouched. This module looks at the VALUES and replaces each match with
// `PII_REDACTION`, keeping the rest of the text ("Bel [redacted] na 17u").
//
// Detected, per cell, including inside free text:
//   • e-mail addresses;
//   • IBANs (validated with the ISO 13616 mod-97 check, compact or in groups of four);
//   • phone numbers — international (`+31 6 1234 5678`, `0044 20 7946 0958`) and Dutch national
//     (`06-12345678`, `020 123 4567`, `(010) 123 4567`): exactly 10 digits starting with 0;
//   • Dutch BSNs — 9 digits (also `1234.56.782` / `123 456 782`) passing the 11-proef;
//   • Dutch postcodes (`1012 AB`, upper case, excluding the unused SA/SD/SS series);
//   • dates in a column whose NAME suggests a date of birth (`geboortedatum`, `dob`, `born_on`).
//
// ⛔ WHO THIS IS FOR. It is applied to (1) member uploads AT REST (routes/information-requests.ts)
// and (2) the member view (`maskRows` / `maskColumns`, datasets/member-view.ts — previews and runs).
// It is NOT applied to a data manager's reads or runs: they see raw values by owner decision, and
// `data.pii_scrubbing` remains the governance switch for those. A false positive here only ever
// HIDES a value from someone who was not entitled to the raw data — the safe direction.
import { PII_REDACTION } from '../db/dataset-types';

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

// Upper case only: a lower-case match would swallow the next word ("… 00 is") into the last group.
const IBAN_RE = /\b[A-Z]{2}\d{2}(?:[A-Z0-9]{11,30}|(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,4})?)\b/g;

// International: `+` or `00`, then 9-15 digits with common separators.
const INTL_PHONE_RE = /(?<![\w+])(?:\+|00)\d[\d \-().]{6,20}\d(?![\d])/g;
// Dutch national: exactly 10 digits starting with 0, single optional separators between digits —
// `06-12345678`, `020 123 4567` — or an area code in brackets, `(010) 123 4567`. Bounded so a
// following number ("06-12345678 2x") cannot be swallowed into the match and break the count.
const NL_PHONE_RE = /(?<![\w])0\d(?:[ \-]?\d){8}(?![\d])/g;
const NL_PHONE_BRACKET_RE = /\(0\d{1,3}\)[ \-]?\d(?:[ \-]?\d){4,7}(?![\d])/g;

const BSN_RE = /(?<![\d.])(?:\d{4}\.\d{2}\.\d{3}|\d{3}[ .]\d{3}[ .]\d{3}|\d{9})(?![\d])/g;

const POSTCODE_RE = /\b[1-9]\d{3} ?(?!SA\b|SD\b|SS\b)[A-Z]{2}\b/g;

const DATE_RE = /\b(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?\b/g;
const BIRTH_COLUMN_RE = /birth|(^|[^a-z])dob([^a-z]|$)|geboorte|geb[._\s-]?dat|born/i;

const digitsOf = (s: string) => s.replace(/\D/g, '');

/** ISO 13616 mod-97 over the compact IBAN. */
export function isValidIban(raw: string): boolean {
  const iban = raw.replace(/ /g, '');
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

/** The Dutch BSN 11-proef: 9·d1 + 8·d2 + … + 2·d8 − 1·d9 ≡ 0 (mod 11), not all zeros. */
export function isValidBsn(raw: string): boolean {
  const d = digitsOf(raw);
  if (d.length !== 9 || /^0+$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += (9 - i) * Number(d[i]);
  sum -= Number(d[8]);
  return sum % 11 === 0;
}

/** Does the column's NAME suggest it holds a date of birth? */
export function isBirthColumn(name: string): boolean {
  return BIRTH_COLUMN_RE.test(name);
}

/** What kind of personal value a match is — so a caller can substitute a value of the same SHAPE
 *  (the run path, datasets/run-mask.ts) instead of the generic `PII_REDACTION`. */
export type PiiKind = 'email' | 'iban' | 'phone' | 'bsn' | 'postcode' | 'birth_date';

export interface ScrubOptions {
  birthColumn?: boolean;
  /** The text that replaces one detected span. Default: `PII_REDACTION` for every kind. */
  replace?: (kind: PiiKind, match: string) => string;
}

/** Replace every detected personal value inside one piece of text. */
export function scrubPiiText(text: string, opts: ScrubOptions = {}): string {
  const rep = opts.replace ?? (() => PII_REDACTION);
  let s = text;
  s = s.replace(EMAIL_RE, (m) => rep('email', m));
  s = s.replace(IBAN_RE, (m) => {
    if (isValidIban(m)) return rep('iban', m);
    // A spaced IBAN can end in a short group that the optional tail mis-took; try without it.
    const cut = m.lastIndexOf(' ');
    return cut > 0 && isValidIban(m.slice(0, cut)) ? rep('iban', m.slice(0, cut)) + m.slice(cut) : m;
  });
  s = s.replace(INTL_PHONE_RE, (m) => {
    const n = digitsOf(m).length - (m.startsWith('00') ? 2 : 0);
    return n >= 9 && n <= 15 ? rep('phone', m) : m;
  });
  s = s.replace(BSN_RE, (m) => (isValidBsn(m) ? rep('bsn', m) : m));
  s = s.replace(NL_PHONE_RE, (m) => rep('phone', m));
  s = s.replace(NL_PHONE_BRACKET_RE, (m) => (digitsOf(m).length === 10 ? rep('phone', m) : m));
  s = s.replace(POSTCODE_RE, (m) => rep('postcode', m));
  if (opts.birthColumn) s = s.replace(DATE_RE, (m) => rep('birth_date', m));
  return s;
}

/** One cell, scrubbed. Strings are scanned; a NUMBER is checked whole (a 9-digit BSN parses as a
 *  number in a CSV) and, in a birth column, any date-shaped value is replaced. Other types pass. */
export function scrubPiiCell(column: string, value: unknown): unknown {
  const birthColumn = isBirthColumn(column);
  if (typeof value === 'string') return scrubPiiText(value, { birthColumn });
  if (typeof value === 'number' && Number.isInteger(value)) {
    const s = String(value);
    return scrubPiiText(s, { birthColumn }) === s ? value : PII_REDACTION;
  }
  if (value instanceof Date) return birthColumn ? PII_REDACTION : value;
  return value;
}

/** Every cell of one row, scrubbed. Returns the SAME object when nothing changed. */
export function scrubPiiRow(row: Record<string, unknown>): Record<string, unknown> {
  let out: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(row)) {
    const next = scrubPiiCell(k, v);
    if (next !== v) {
      out ??= { ...row };
      out[k] = next;
    }
  }
  return out ?? row;
}
