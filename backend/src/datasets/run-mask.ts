// src/datasets/run-mask.ts — TYPE-PRESERVING masking of a RUN's datasets for a reader who is not a
// data manager (W8, 2026-10-15).
//
// ⛔ WHY THIS IS NOT `maskRows`. The preview path (`maskRows`, member-view.ts) blanks a masked cell
// to the string `PII_REDACTION`. That is fine for a table a person reads, and FATAL for a run: a
// typed step that declares `amount: number` receives "[redacted]" and the run fails with
// "'amount' must be a finite number" — on any numeric/date/boolean column a member may not see,
// which by the member-view rule includes every UNMAPPED column. "Test with this challenge's sample
// data" broke on exactly that in the live walk. So a run gets values of the SAME TYPE that are not
// the originals:
//
//   COLUMN-MASKED cells (the `memberMasks` set — PII-flagged or not confirmed-mapped to a non-PII
//   attribute):
//     • number   → a synthetic number with the same sign, the same number of integer digits and the
//                  same number of decimals (an integer stays an integer); never the original value,
//                  and never a value the BSN 11-proef accepts. Seeded by tenant + dataset + column +
//                  row, so a re-run (and a test) sees the same numbers.
//     • date     → shifted by a per-COLUMN offset of 30–365 days (same offset for every row, so the
//                  ordering within a column is kept exactly), in the original FORMAT (ISO, ISO
//                  timestamp, day-first `15-01-2026`). A `Date` object stays a `Date`.
//     • boolean  → kept. A yes/no carries one bit and identifies nobody on its own; replacing it
//                  would only make every boolean branch of a flow untestable for members.
//     • string   → a stable pseudonym `value-1`, `value-2`, … per column, numbered by first
//                  appearance (equal originals → equal pseudonyms, so grouping still works). Neutral
//                  on purpose — it is DATA, not UI, and must not depend on the reader's locale.
//     • object / array → the same rules applied to every leaf.
//   OTHER cells (a column the member may see): only VALUE-detected personal data is replaced, and
//   only the matched span, with a placeholder that is still a string of the same shape and that the
//   detector itself would not flag again — `email@example.invalid`, `+31 6 00000000`,
//   `000000000` (fails the 11-proef: all zeros), `NL00BANK0000000000` (00 is never a valid IBAN
//   check), `0000 XX`; a date of birth is shifted like a date. A BSN that parsed as a NUMBER is
//   replaced by a synthetic number.
//   null / undefined / '' → unchanged.
//
// Column metadata (`DatasetColumn.type`) is never changed, so the ontology validation and every
// typed block see the declared types. The column `sample` is masked with the same rules.
import { createHash } from 'node:crypto';
import type { DatasetColumn } from '../db/dataset-types';
import { isBirthColumn, scrubPiiCell, scrubPiiText, type PiiKind } from './pii-values';

const DAY_MS = 86_400_000;

export const RUN_PLACEHOLDER: Record<Exclude<PiiKind, 'birth_date'>, string> = {
  email: 'email@example.invalid',
  phone: '+31 6 00000000',
  bsn: '000000000',
  iban: 'NL00BANK0000000000',
  postcode: '0000 XX',
};

/** A deterministic [0,1) stream from a string seed (sha256 → mulberry32). */
function rng(seed: string): () => number {
  let a = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function decimalsOf(v: number): number {
  const s = String(v);
  if (s.includes('e')) return 6;
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

/** A synthetic number of the same kind as `v`; never `v` itself. Exported for the tests. */
export function synthNumber(v: number, rnd: () => number, column = ''): number {
  if (!Number.isFinite(v)) return v;
  const sign = v < 0 ? -1 : 1;
  const a = Math.abs(v);
  if (Number.isInteger(v) && a <= Number.MAX_SAFE_INTEGER) {
    const digits = a === 0 ? 1 : Math.min(15, Math.floor(Math.log10(a)) + 1);
    const lo = digits === 1 ? 0 : 10 ** (digits - 1);
    const hi = 10 ** digits - 1;
    let n = lo + Math.floor(rnd() * (hi - lo + 1));
    // Never the original; never a value the value detector would flag (a 9-digit 11-proef pass).
    for (let i = 0; i < 40 && (n === a || scrubPiiCell(column, n) !== n); i++) n = n >= hi ? lo : n + 1;
    return n === 0 ? 0 : sign * n;
  }
  const dec = Math.min(decimalsOf(v), 10);
  const intDigits = a < 1 ? 0 : Math.floor(Math.log10(a)) + 1;
  const lo = intDigits === 0 ? 0 : 10 ** (intDigits - 1);
  const hi = 10 ** Math.max(intDigits, 1);
  const f = 10 ** dec;
  let n = Math.round((lo + rnd() * (hi - lo)) * f) / f;
  if (n >= hi) n = lo;
  if (n === a) n = Math.round((n + 1 / f) * f) / f;
  return sign * n;
}

const pad = (n: number, width: number) => String(n).padStart(width, '0');
const ISO_RE = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})((?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})?)$/;
const DMY_RE = /^(\d{1,2})([-/.])(\d{1,2})\2(\d{4})((?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?)$/;

function shiftYmd(y: number, m: number, d: number, days: number): [number, number, number] | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  if (back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  const s = new Date(t + days * DAY_MS);
  return [s.getUTCFullYear(), s.getUTCMonth() + 1, s.getUTCDate()];
}

/** `text` shifted by `days`, in its own format — or null when it is not a date this understands. */
export function shiftDateString(text: string, days: number): string | null {
  const iso = ISO_RE.exec(text);
  if (iso) {
    const [, ys, sep, ms, ds, rest] = iso;
    const r = shiftYmd(Number(ys), Number(ms), Number(ds), days);
    return r ? `${pad(r[0], 4)}${sep}${pad(r[1], ms!.length)}${sep}${pad(r[2], ds!.length)}${rest}` : null;
  }
  const dmy = DMY_RE.exec(text);
  if (dmy) {
    const [, as, sep, bs, ys, rest] = dmy;
    // Day-first (Dutch), unless the second part cannot be a month — then it was month-first.
    const monthFirst = Number(bs) > 12;
    const [d, m] = monthFirst ? [Number(bs), Number(as)] : [Number(as), Number(bs)];
    const r = shiftYmd(Number(ys), m, d, days);
    if (!r) return null;
    const [first, second] = monthFirst ? [r[1], r[2]] : [r[2], r[1]];
    return `${pad(first, as!.length)}${sep}${pad(second, bs!.length)}${sep}${pad(r[0], 4)}${rest}`;
  }
  return null;
}

/** Everything the masker needs about one dataset column, built once per column. */
interface ColumnCtx {
  name: string;
  type: DatasetColumn['type'] | undefined;
  masked: boolean;
  birth: boolean;
  seed: string;
  /** Per-column date offset in days: ±30–365, never 0. */
  shiftDays: number;
  pseudonyms: Map<string, string>;
}

function columnCtx(seedBase: string, name: string, type: DatasetColumn['type'] | undefined, masked: boolean): ColumnCtx {
  const seed = `${seedBase}\u0000${name}`;
  const r = rng(`${seed}\u0000date-shift`);
  const days = 30 + Math.floor(r() * 336);
  return {
    name,
    type,
    masked,
    birth: isBirthColumn(name),
    seed,
    shiftDays: r() < 0.5 ? -days : days,
    pseudonyms: new Map(),
  };
}

function pseudonym(c: ColumnCtx, value: string): string {
  let p = c.pseudonyms.get(value);
  if (!p) {
    p = `value-${c.pseudonyms.size + 1}`;
    if (p === value) p = `${p}-x`;
    c.pseudonyms.set(value, p);
  }
  return p;
}

function maskedValue(c: ColumnCtx, value: unknown, rowKey: string): unknown {
  if (value === null || value === undefined || value === '') return value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return synthNumber(value, rng(`${c.seed}\u0000${rowKey}`), c.name);
  if (value instanceof Date) return new Date(value.getTime() + c.shiftDays * DAY_MS);
  if (typeof value === 'string') {
    const shifted = shiftDateString(value, c.shiftDays);
    if (shifted !== null) return shifted;
    return pseudonym(c, value);
  }
  if (Array.isArray(value)) return value.map((v, i) => maskedValue(c, v, `${rowKey}.${i}`));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = maskedValue(c, v, `${rowKey}.${k}`);
    return out;
  }
  return pseudonym(c, String(value));
}

function scrubbedValue(c: ColumnCtx, value: unknown, rowKey: string): unknown {
  if (value === null || value === undefined || value === '') return value;
  if (typeof value === 'string') {
    if (c.birth) {
      const shifted = shiftDateString(value, c.shiftDays);
      if (shifted !== null) return shifted;
    }
    return scrubPiiText(value, {
      birthColumn: c.birth,
      replace: (kind, m) =>
        kind === 'birth_date' ? (shiftDateString(m, c.shiftDays) ?? '1900-01-01') : RUN_PLACEHOLDER[kind],
    });
  }
  if (typeof value === 'number') {
    return scrubPiiCell(c.name, value) === value ? value : synthNumber(value, rng(`${c.seed}\u0000${rowKey}`), c.name);
  }
  if (value instanceof Date) return c.birth ? new Date(value.getTime() + c.shiftDays * DAY_MS) : value;
  return value;
}

/**
 * One dataset's columns + rows as a member's RUN reads them. `seedBase` must identify the tenant
 * and the dataset (the caller passes `${tenantId}:${datasetId}`). `masked` is the `memberMasks`
 * set. Column TYPES are returned unchanged.
 */
export function maskDatasetForRun(
  seedBase: string,
  columns: DatasetColumn[],
  rows: Record<string, unknown>[],
  masked: string[],
): { columns: DatasetColumn[]; rows: Record<string, unknown>[] } {
  const maskedSet = new Set(masked);
  const ctxs = new Map<string, ColumnCtx>();
  const ctxOf = (name: string): ColumnCtx => {
    let c = ctxs.get(name);
    if (!c) {
      const col = columns.find((x) => x.name === name);
      // A key the metadata does not list cannot be classified: mask it rather than guess.
      c = columnCtx(seedBase, name, col?.type, maskedSet.has(name) || !col);
      ctxs.set(name, c);
    }
    return c;
  };
  const cell = (name: string, v: unknown, rowKey: string) => {
    const c = ctxOf(name);
    return c.masked ? maskedValue(c, v, rowKey) : scrubbedValue(c, v, rowKey);
  };
  const outRows = rows.map((r, i) => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) o[k] = cell(k, v, String(i));
    return o;
  });
  const outColumns = columns.map((col) =>
    col.sample === undefined ? col : { ...col, sample: cell(col.name, col.sample, 'sample') as DatasetColumn['sample'] },
  );
  return { columns: outColumns, rows: outRows };
}
